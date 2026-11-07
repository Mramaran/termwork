import { Buffer } from "buffer";

// The Intear wallet's message signing calls Node's Buffer, which browsers lack. Imported first by main.tsx.
const g = globalThis as { Buffer?: typeof Buffer };
g.Buffer ??= Buffer;
