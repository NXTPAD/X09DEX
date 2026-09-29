// Compiles contracts/X09Token.sol in the browser with the official Solidity compiler (solc-js).
// Runs in a Web Worker so the page stays responsive. The compiler (~9 MB) is cached by the browser.
const VERSION = "0.8.26";
const BIN = "https://binaries.soliditylang.org/bin/";

let compileFn = null;

async function loadCompiler() {
  if (compileFn) return compileFn;
  let file = "soljson-v0.8.26+commit.8a97fa7a.js";
  try {
    importScripts(BIN + file);
  } catch (e) {
    const list = await fetch(BIN + "list.json").then((r) => r.json());
    file = list.releases[VERSION];
    if (!file) throw new Error("Compiler version not found");
    importScripts(BIN + file);
  }
  // Wait until the embedded WebAssembly runtime is ready.
  const start = Date.now();
  while (true) {
    try {
      const M = self.Module;
      if (M && (M.calledRun || M.asm || M.wasmExports)) {
        const fn = M.cwrap("solidity_compile", "string", ["string", "number", "number"]);
        fn("{}", 0, 0); // throws if not ready
        compileFn = fn;
        return fn;
      }
    } catch {}
    if (Date.now() - start > 60000) throw new Error("Compiler failed to start");
    await new Promise((r) => setTimeout(r, 100));
  }
}

self.onmessage = async (e) => {
  const { source } = e.data;
  try {
    self.postMessage({ progress: "loading compiler" });
    const compile = await loadCompiler();
    self.postMessage({ progress: "compiling" });
    const input = {
      language: "Solidity",
      sources: { "X09Token.sol": { content: source } },
      settings: {
        optimizer: { enabled: true, runs: 200 },
        evmVersion: "paris", // widest chain compatibility (no PUSH0)
        outputSelection: { "*": { X09Token: ["abi", "evm.bytecode.object", "evm.methodIdentifiers"] } },
      },
    };
    const out = JSON.parse(compile(JSON.stringify(input), 0, 0));
    const errors = (out.errors || []).filter((x) => x.severity === "error");
    if (errors.length) throw new Error(errors.map((x) => x.formattedMessage || x.message).join("\n"));
    const c = out.contracts["X09Token.sol"].X09Token;
    self.postMessage({
      ok: true,
      version: VERSION,
      bytecode: c.evm.bytecode.object,
      abi: c.abi,
      methods: c.evm.methodIdentifiers,
    });
  } catch (err) {
    self.postMessage({ ok: false, error: err.message || String(err) });
  }
};
