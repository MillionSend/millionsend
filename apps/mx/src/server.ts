import { parseMxEnv } from "./env.js";

// Throws on missing or partial configuration, so boot fails before any
// listener starts.
parseMxEnv(process.env);
