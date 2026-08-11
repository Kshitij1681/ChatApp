import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { createSocket } from "../lib/socket.js";
import Sidebar from "../components/Sidebar.jsx";
import Thread from "../components/Thread.jsx";
import EmptyThread from "../components/EmptyThread.jsx";
import Settings from "./Settings.jsx";

/**
 * Owns the socket and all shared state. Frames arrive here and fan out to the
 * sidebar and the open thread, so there is exactly one place where a message
 * becomes part of the app.
 */
export default function Messenger({ me, onSignedOut }) {
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState({}); // conversationId -> message[]
  const [cursors, setCursors] = useState({}); // conversationId -> { next, hasMore }
  const [typing, setTyping] = useState({}); // conversationId -> timeout id
  const [highlight, setHighlight] = useState(null); // { conversationId, messageId }
  const [status, setStatus] = useState("connecting");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const socketRef = useRef(null);
  const activeIdRef = useRef(null);
  activeIdRef.current = activeId;
  // Read inside handleFrame, which must not re-subscribe every time a cursor
  // moves — a ref keeps the socket effect stable.
  const cursorsRef = useRef({});
  cursorsRef.current = cursors;

  const upsertConversation = useCallback((next) => {
    setConversations((list) => {
      const i = list.findIndex((c) => c.id === next.id);
      const merged = i === -1 ? next : { ...list[i], ...next };
      const rest = i === -1 ? list : [...list.slice(0, i), ...list.slice(i + 1)];
      return [merged, ...rest].sort(
        (a, b) => new Date(b.lastMessage?.at ?? 0) - new Date(a.lastMessage?.at ?? 0),
      );
    });
  }, []);

  const handleFrame = useCallback(
    (frame) => {
      switch (frame.type) {
        case "msg:new": {
          const { message, clientId } = frame;
          const convoId = message.conversationId;
          const isMine = message.from === me.id;
          const isOpen = activeIdRef.current === convoId;

          setMessages((byConvo) => {
            const list = byConvo[convoId];
            // A thread we've never opened has no cached list — leave it unset so
            // the first open still fetches a real page instead of showing one row.
            if (!list) return byConvo;
            // A thread parked on a search result isn't showing the live end, so
            // appending here would put this message directly after older ones it
            // doesn't follow. Drop it; returning to the bottom refetches.
            if (cursorsRef.current[convoId]?.hasNewer) return byConvo;
            // Swap the optimistic bubble for the persisted row, matched on the
            // clientId we sent with it.
            const optimisticIndex = clientId ? list.findIndex((m) => m.clientId === clientId) : -1;
            if (optimisticIndex !== -1) {
              const copy = [...list];
              copy[optimisticIndex] = message;
              return { ...byConvo, [convoId]: copy };
            }
            if (list.some((m) => m.id === message.id)) return byConvo;
            return { ...byConvo, [convoId]: [...list, message] };
          });

          setConversations((list) => {
            const i = list.findIndex((c) => c.id === convoId);
            if (i === -1) {
              // First message from someone new: the sidebar doesn't know them yet.
              refresh();
              return list;
            }
            const bumped = {
              ...list[i],
              lastMessage: {
                preview: message.body ?? "",
                kind: message.kind,
                from: message.from,
                at: message.at,
                deleted: message.deleted,
              },
              // An open, focused thread is read on arrival, so it never blinks
              // an unread badge the reader has to dismiss.
              unread: isMine || isOpen ? 0 : (list[i].unread ?? 0) + 1,
              closedByPeer: false,
            };
            return [bumped, ...list.slice(0, i), ...list.slice(i + 1)];
          });

          if (!isMine && isOpen && document.visibilityState === "visible") {
            socketRef.current?.send({ type: "msg:read", conversationId: convoId, upTo: message.id });
          }
          break;
        }

        case "msg:status": {
          // Receipts are monotonic: a late `delivered` must never unset `read`.
          setMessages((byConvo) => {
            const list = byConvo[frame.conversationId];
            if (!list) return byConvo;
            return {
              ...byConvo,
              [frame.conversationId]: list.map((m) =>
                m.from === me.id && !m.readAt
                  ? { ...m, readAt: frame.status === "read" ? frame.at : m.readAt, deliveredAt: m.deliveredAt ?? frame.at }
                  : m,
              ),
            };
          });
          break;
        }

        case "presence": {
          setConversations((list) =>
            list.map((c) =>
              c.peer?.id === frame.userId
                ? { ...c, peer: { ...c.peer, online: frame.online, lastSeenAt: frame.lastSeenAt } }
                : c,
            ),
          );
          break;
        }

        case "typing": {
          const { conversationId } = frame;
          setTyping((map) => {
            clearTimeout(map[conversationId]);
            if (!frame.typing) return { ...map, [conversationId]: null };
            // Self-expiring: a "stopped" frame lost to a dropped socket would
            // otherwise leave the indicator on forever.
            const timer = setTimeout(
              () => setTyping((m) => ({ ...m, [conversationId]: null })),
              3000,
            );
            return { ...map, [conversationId]: timer };
          });
          break;
        }

        case "msg:deleted": {
          const { conversationId, messageId, lastMessage } = frame;
          // The row stays and becomes a tombstone rather than being spliced out —
          // removing it would reflow the timeline under whoever is reading it, and
          // the two sides would stop agreeing on what the history looked like.
          setMessages((byConvo) => {
            const list = byConvo[conversationId];
            if (!list) return byConvo;
            return {
              ...byConvo,
              [conversationId]: list.map((m) =>
                m.id === messageId
                  ? { id: m.id, conversationId, from: m.from, kind: "text", at: m.at, deleted: true }
                  : m,
              ),
            };
          });
          setConversations((list) =>
            list.map((c) => (c.id === conversationId ? { ...c, lastMessage: lastMessage ?? null } : c)),
          );
          break;
        }

        case "convo:cleared": {
          // Another tab of mine cleared this thread. Drop the cache so reopening
          // refetches rather than re-showing what the server no longer serves.
          const { conversationId } = frame;
          setConversations((list) => list.filter((c) => c.id !== conversationId));
          setMessages((byConvo) => {
            const { [conversationId]: _gone, ...rest } = byConvo;
            return rest;
          });
          if (activeIdRef.current === conversationId) setActiveId(null);
          break;
        }

        case "convo:destroyed": {
          // They destroyed it for both of us. The row survives carrying the
          // notice — the only account the reader gets of where their history
          // went — so this empties the thread rather than removing it.
          const { conversationId } = frame;
          setMessages((byConvo) => ({ ...byConvo, [conversationId]: [] }));
          setConversations((list) =>
            list.map((c) =>
              c.id === conversationId ? { ...c, lastMessage: null, unread: 0, closedByPeer: true } : c,
            ),
          );
          break;
        }

        case "peer:deleted": {
          // Their account is gone. Refetching is simpler than patching every
          // peer field, and the server is the only thing that knows whether the
          // messages survived as "Deleted user" or went with them.
          refresh();
          if (frame.purged) {
            setMessages((byConvo) => {
              const { [frame.conversationId]: _gone, ...rest } = byConvo;
              return rest;
            });
          }
          break;
        }

        case "error": {
          // The server echoes clientId on a rejected send, so exactly one bubble
          // is marked failed. Without it we'd know a send failed but not which,
          // and the optimistic bubble would spin forever.
          if (!frame.clientId) break;
          setMessages((byConvo) =>
            Object.fromEntries(
              Object.entries(byConvo).map(([convoId, list]) => [
                convoId,
                list.map((m) =>
                  m.clientId === frame.clientId ? { ...m, pending: false, failed: true, error: frame.error } : m,
                ),
              ]),
            ),
          );
          break;
        }

        default:
          break;
      }
    },
    [me.id],
  );

  const refresh = useCallback(async () => {
    try {
      const { conversations: list } = await api.conversations();
      setConversations(list);
    } catch {
      /* the sidebar keeps what it has */
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const socket = createSocket({ onMessage: handleFrame, onStatus: setStatus });
    socketRef.current = socket;
    return () => socket.close();
  }, [handleFrame]);

  // A socket that dropped may have missed frames, so resync on reconnect rather
  // than trusting local state to have kept up.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (status === "open" && wasOpen.current) refresh();
    if (status === "open") wasOpen.current = true;
  }, [status, refresh]);

  const openConversation = useCallback(
    async (id) => {
      setActiveId(id);
      setHighlight(null);
      setConversations((list) => list.map((c) => (c.id === id ? { ...c, unread: 0 } : c)));

      if (!messages[id]) {
        try {
          const page = await api.messages(id);
          setMessages((byConvo) => ({ ...byConvo, [id]: page.messages }));
          setCursors((c) => ({ ...c, [id]: { next: page.nextCursor, hasMore: page.hasMore, hasNewer: false } }));
        } catch {
          setMessages((byConvo) => ({ ...byConvo, [id]: [] }));
        }
      }
      socketRef.current?.send({ type: "msg:read", conversationId: id });
    },
    [messages],
  );

  /**
   * Opens a thread positioned on one message rather than at the bottom — how a
   * search result is followed. The window replaces any cached page, because
   * splicing a distant window into the tail would leave a silent gap in the
   * middle of the thread with nothing to mark it.
   */
  const jumpToMessage = useCallback(async (conversationId, messageId) => {
    setActiveId(conversationId);
    setHighlight({ conversationId, messageId });
    setConversations((list) => list.map((c) => (c.id === conversationId ? { ...c, unread: 0 } : c)));
    try {
      const page = await api.messages(conversationId, { at: messageId });
      setMessages((byConvo) => ({ ...byConvo, [conversationId]: page.messages }));
      setCursors((c) => ({
        ...c,
        [conversationId]: { next: page.nextCursor, hasMore: page.hasMore, hasNewer: page.hasNewer },
      }));
    } catch {
      setHighlight(null);
    }
  }, []);

  /** Back to the live end from a search window, discarding the window. */
  const returnToLatest = useCallback(async (id) => {
    setHighlight(null);
    const page = await api.messages(id);
    setMessages((byConvo) => ({ ...byConvo, [id]: page.messages }));
    setCursors((c) => ({ ...c, [id]: { next: page.nextCursor, hasMore: page.hasMore, hasNewer: false } }));
    socketRef.current?.send({ type: "msg:read", conversationId: id });
  }, []);

  const loadOlder = useCallback(
    async (id) => {
      const cursor = cursors[id];
      if (!cursor?.hasMore || !cursor.next) return;
      const page = await api.messages(id, { before: cursor.next });
      setMessages((byConvo) => ({ ...byConvo, [id]: [...page.messages, ...(byConvo[id] ?? [])] }));
      setCursors((c) => ({ ...c, [id]: { ...c[id], next: page.nextCursor, hasMore: page.hasMore } }));
    },
    [cursors],
  );

  const startConversation = useCallback(
    async (username) => {
      const { conversation } = await api.openConversation(username);
      upsertConversation(conversation);
      await openConversation(conversation.id);
      return conversation;
    },
    [openConversation, upsertConversation],
  );

  const sendMessage = useCallback(
    async (conversationId, body, fileId = null, meta = {}) => {
      // Sending from a search window: snap back to the live end first, or the
      // new bubble would render immediately after months-old history.
      if (cursorsRef.current[conversationId]?.hasNewer) {
        await returnToLatest(conversationId).catch(() => {});
      }

      const clientId = `local-${crypto.randomUUID()}`;
      // Optimistic bubble, replaced when the server echoes with the real id.
      const optimistic = {
        id: clientId,
        clientId,
        conversationId,
        from: me.id,
        // The server decides the real kind from the stored file; this is only
        // what the optimistic bubble renders for the moment before the echo.
        kind: fileId ? (meta.kind ?? "file") : "text",
        body,
        attachment: fileId
          ? { fileId, name: meta.name ?? "", mime: meta.mime ?? "", size: meta.size ?? 0, durationMs: meta.durationMs ?? null }
          : null,
        at: new Date().toISOString(),
        deliveredAt: null,
        readAt: null,
        deleted: false,
        pending: true,
      };
      setMessages((byConvo) => ({ ...byConvo, [conversationId]: [...(byConvo[conversationId] ?? []), optimistic] }));

      const sent = socketRef.current?.send({
        type: "msg:send",
        conversationId,
        body,
        clientId,
        ...(fileId ? { fileId, ...meta } : {}),
      });
      if (!sent) {
        setMessages((byConvo) => ({
          ...byConvo,
          [conversationId]: (byConvo[conversationId] ?? []).map((m) =>
            m.clientId === clientId ? { ...m, pending: false, failed: true } : m,
          ),
        }));
      }
    },
    [me.id, returnToLatest],
  );

  const sendTyping = useCallback((conversationId, isTyping) => {
    socketRef.current?.send({ type: "typing", conversationId, typing: isTyping });
  }, []);

  /**
   * The three deletions. Each one waits for the server rather than removing
   * anything optimistically — an optimistic delete that fails leaves the reader
   * believing something is gone when it isn't, which is the one direction this
   * feature must never be wrong in. The socket frame does the removing, so the
   * deleter's other tabs update through the same path as the other person's.
   */
  const deleteMessage = useCallback(async (conversationId, messageId) => {
    await api.deleteMessage(conversationId, messageId);
  }, []);

  const deleteConversation = useCallback(
    async (id, scope) => {
      await api.deleteConversation(id, scope);
      if (scope === "everyone") {
        // Only the peer gets convo:destroyed; my own copy is cleared, and the
        // convo:cleared frame that follows takes it off my sidebar.
        setMessages((byConvo) => ({ ...byConvo, [id]: [] }));
      }
      await refresh();
    },
    [refresh],
  );

  const dismissConversation = useCallback(
    async (id) => {
      await api.dismissConversation(id);
      await refresh();
    },
    [refresh],
  );

  const active = useMemo(() => conversations.find((c) => c.id === activeId) ?? null, [conversations, activeId]);

  async function signOut() {
    try {
      await api.logout();
    } finally {
      socketRef.current?.close();
      onSignedOut();
    }
  }

  return (
    <div className="flex h-dvh bg-ground">
      <Sidebar
        me={me}
        status={status}
        conversations={conversations}
        activeId={activeId}
        onOpen={openConversation}
        onStart={startConversation}
        onJump={jumpToMessage}
        onSignOut={signOut}
        onOpenSettings={() => setSettingsOpen(true)}
        onDismiss={dismissConversation}
      />
      <main className="relative flex min-w-0 flex-1 flex-col">
        {active ? (
          <Thread
            key={active.id}
            me={me}
            conversation={active}
            messages={messages[active.id] ?? null}
            hasMore={cursors[active.id]?.hasMore ?? false}
            hasNewer={cursors[active.id]?.hasNewer ?? false}
            highlightId={highlight?.conversationId === active.id ? highlight.messageId : null}
            peerTyping={!!typing[active.id]}
            onSend={sendMessage}
            onTyping={sendTyping}
            onLoadOlder={loadOlder}
            onReturnToLatest={returnToLatest}
            onDeleteMessage={deleteMessage}
            onDeleteConversation={deleteConversation}
            onDismiss={dismissConversation}
          />
        ) : (
          <EmptyThread me={me} />
        )}
      </main>

      {settingsOpen ? (
        <Settings
          me={me}
          onClose={() => setSettingsOpen(false)}
          onDeleted={() => {
            // The server has already killed the session and closed the socket.
            // Closing this end too stops the reconnect loop from hammering a
            // door that is now locked.
            socketRef.current?.close();
            onSignedOut();
          }}
        />
      ) : null}
    </div>
  );
}
