export function captureEnvValues(keys, env = process.env) {
  const snapshot = new Map();
  for (const key of keys || []) {
    snapshot.set(key, Object.prototype.hasOwnProperty.call(env, key) ? env[key] : undefined);
  }
  return snapshot;
}

export function restoreEnvValues(snapshot, env = process.env) {
  for (const [key, value] of snapshot || []) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
}

export function withEnvValues(values, fn, env = process.env) {
  const entries = Object.entries(values || {});
  const snapshot = captureEnvValues(entries.map(([key]) => key), env);
  for (const [key, value] of entries) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  try {
    return fn();
  } finally {
    restoreEnvValues(snapshot, env);
  }
}
