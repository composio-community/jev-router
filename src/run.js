// Spawn an agent CLI, stream its stdout line by line, collect stderr, and enforce a timeout.
import { spawn } from 'node:child_process';

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{cwd:string, onLine:(line:string)=>void, onStderr?:(chunk:string)=>void, timeoutMs?:number, env?:object, stdin?:string}} opts
 * @returns {Promise<{code:number|null, stderr:string, killed:boolean}>}
 */
export function runStreaming(cmd, args, { cwd, onLine, onStderr, timeoutMs = 30 * 60 * 1000, env, stdin, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    const onAbort = () => {
      killed = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    };
    if (signal?.aborted) onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          onLine(line);
        } catch {
          /* a bad line must not kill the run */
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
      onStderr?.(chunk);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (buf.trim()) {
        try {
          onLine(buf);
        } catch {
          /* ignore */
        }
      }
      resolve({ code, stderr, killed, aborted: Boolean(signal?.aborted) });
    });
    if (stdin != null) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

/** Parse a JSON line, or return null. */
export function jsonLine(line) {
  const s = line.trim();
  if (!s.startsWith('{')) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Find a session-looking id anywhere in an object (used for agents whose event shapes are not documented). */
export function sniffSessionId(obj) {
  const keys = /^(session_?id|sessionID|sessionId|thread_?id|chat_?id|conversation_?id)$/i;
  const seen = new Set();
  const walk = (v, depth) => {
    if (!v || typeof v !== 'object' || depth > 4 || seen.has(v)) return null;
    seen.add(v);
    for (const [k, val] of Object.entries(v)) {
      if (keys.test(k) && typeof val === 'string' && val.length >= 6) return val;
    }
    for (const val of Object.values(v)) {
      const r = walk(val, depth + 1);
      if (r) return r;
    }
    return null;
  };
  return walk(obj, 0);
}
