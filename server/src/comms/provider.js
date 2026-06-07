// CommsProvider interface (Appendix A) + a name->provider registry.
// Providers are channel implementations; tools dispatch on `provider`.

export class NotImplemented extends Error {
  constructor(method) {
    super(`CommsProvider.${method} is not implemented by this provider`);
    this.name = "NotImplemented";
    this.method = method;
  }
}

// Abstract base. Subclasses (WhatsAppProvider, future TelegramProvider) override.
// link(accountId, opts:{phone?})        -> { method:'qr'|'pairing', payload }
// status(accountId)                      -> 'connected'|'needs_login'|'logged_out'
// unlink(accountId)                      -> wipe session files
// listChats(accountId)                   -> [{id,name,chatKind}]
// listGroups(accountId)                  -> [{id,name,chatKind:'group'}]
// getMessages(accountId, chatId, {limit,before,after}) -> Msg[] (best-effort backfill)
// onMessage(cb)                          -> live stream of normalized Msg
// getSessionDir(accountId)               -> auth dir path
export class CommsProvider {
  constructor(name) { this.name = name; }
  link() { throw new NotImplemented("link"); }
  status() { throw new NotImplemented("status"); }
  unlink() { throw new NotImplemented("unlink"); }
  listChats() { throw new NotImplemented("listChats"); }
  listGroups() { throw new NotImplemented("listGroups"); }
  getMessages() { throw new NotImplemented("getMessages"); }
  onMessage() { throw new NotImplemented("onMessage"); }
  getSessionDir() { throw new NotImplemented("getSessionDir"); }
  // Declared for v2, intentionally unimplemented in v1 (§Appendix A).
  sendText() { throw new Error("sendText is deferred to v2"); }
  sendMedia() { throw new Error("sendMedia is deferred to v2"); }
}

export class ProviderRegistry {
  constructor() {
    this._factories = new Map(); // name -> (deps) => CommsProvider
    this._instances = new Map(); // name -> CommsProvider (singleton)
  }
  register(name, factory) { this._factories.set(name, factory); }
  names() { return [...this._factories.keys()]; }
  get(name, deps) {
    if (this._instances.has(name)) return this._instances.get(name);
    const factory = this._factories.get(name);
    if (!factory) throw new Error(`unknown provider: ${name}`);
    const inst = factory(deps);
    this._instances.set(name, inst);
    return inst;
  }
}
