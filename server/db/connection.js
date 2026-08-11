import mongoose from "mongoose";
import { MONGODB_URI } from "../config.js";

export async function connect() {
  mongoose.set("strictQuery", true);
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  console.log("[chat] mongo connected");
  return mongoose.connection;
}

export async function disconnect() {
  await mongoose.disconnect();
}
