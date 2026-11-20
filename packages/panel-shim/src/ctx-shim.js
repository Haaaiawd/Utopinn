/**
 * Utopinn panel shim — Luker CardApp ctx face (TASK-046).
 *
 * Injected into the card sandbox (iframe / RN WebView) before module card code.
 * Builds `window.__CARDAPP_CTX__` — the object a module entry's `init(ctx)`
 * receives — over the same 'utopinn-panel' postMessage wire as runtime.js.
 *
 * Boundary:
 *   - realm-local (never crosses the wire): container, parentDoc, eventSource,
 *     lukerContext, timers, renderer registry, varCache/chatCache reads.
 *   - bridged (request → host ctx.* dispatch): chat/state reads+writes,
 *     variables, generation, slash commands, extension prompts, WI books.
 *
 * Push side: 'host.event' / 'th.event' / 'chat.updated' payloads re-emit on
 * ctx.eventSource (and the TH-style local listener registry) so a single card
 * can listen with either face.
 *
 * Host contract: identical to runtime.js
 *   out: {channel:'utopinn-panel',direction:'request',nonce,requestId,method,args}
 *   in : window.__utopinnPanelReceive({direction:'response'|'push',...})
 *   bootstrap: window.__UTOPINN_PANEL_NONCE__ + window.__UTOPINN_PANEL_BOOTSTRAP__
 *              (face:'ctx', mountId, charId, chatName, entry, assetBase,
 *               stateNamespaces)
 */
(function () {
    'use strict';

    var NONCE = (typeof window.__UTOPINN_PANEL_NONCE__ === 'string') ? window.__UTOPINN_PANEL_NONCE__ : '';
    var BOOTSTRAP = window.__UTOPINN_PANEL_BOOTSTRAP__ || {};

    var pending = {};
    var seq = 0;
    var listeners = {};        // TH-style event -> [{fn, once}]
    var ctxListeners = {};     // ctx.eventSource event -> [{fn, once}]
    var varCache = {};         // chat_metadata.variables snapshot (getVariable reads this)
    var chatCache = [];        // latest raw message array (getHistory/lukerContext.chat)
    var chatHeader = null;     // latest chat header
    var dead = false;
    var disposeCallbacks = [];
    var trackedIntervals = [];
    var trackedTimeouts = [];
    var trackedListeners = [];

    // ── transport (identical envelope to runtime.js) ───────────────────────
    function post(msg) {
        if (typeof window.__utopinnPanelPost === 'function') { window.__utopinnPanelPost(msg); return; }
        if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
            window.ReactNativeWebView.postMessage(JSON.stringify(msg)); return;
        }
        if (window.parent && window.parent !== window) {
            window.parent.postMessage(msg, '*'); return;
        }
        throw new Error('no panel transport available');
    }

    function request(method, args) {
        return new Promise(function (resolve, reject) {
            if (dead) return reject(new Error('ctx disposed'));
            var id = 'r' + (++seq);
            pending[id] = { resolve: resolve, reject: reject };
            try {
                post({ channel: 'utopinn-panel', direction: 'request', nonce: NONCE, requestId: id, method: method, args: args || {} });
            } catch (e) {
                delete pending[id];
                reject(e);
            }
        });
    }

    function jsonClone(v) {
        if (v === undefined) return undefined;
        try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; }
    }

    // ── event registries (TH-style + ctx.eventSource share one dispatch) ──
    function dispatchLocal(name, args) {
        var out = [];
        var lists = [listeners[name] || [], ctxListeners[name] || []];
        for (var l = 0; l < lists.length; l++) {
            var list = lists[l].slice();
            for (var i = 0; i < list.length; i++) {
                var entry = list[i];
                try { out.push(entry.fn.apply(null, args)); }
                catch (e) { console.warn('[ctx-shim] listener for ' + name + ' threw', e); }
                if (entry.once) removeListenerEverywhere(name, entry.fn);
            }
        }
        return out;
    }

    function removeListenerEverywhere(name, fn) {
        [listeners, ctxListeners].forEach(function (reg) {
            var list = reg[name] || [];
            for (var i = list.length - 1; i >= 0; i--) if (list[i].fn === fn) list.splice(i, 1);
        });
    }

    function addListener(reg, name, fn, once) {
        (reg[name] = reg[name] || []).push({ fn: fn, once: !!once });
    }

    // chat snapshot refresh — keeps varCache/chatCache truthful after pushes
    var refreshTimer = null;
    function scheduleChatRefresh(delay) {
        if (refreshTimer) return;
        refreshTimer = setTimeout(function () {
            refreshTimer = null;
            refreshChat().catch(function () { /* snapshot stays stale */ });
        }, delay == null ? 250 : delay);
    }

    function refreshChat() {
        return request('ctx.getChat', {}).then(function (res) {
            if (res && typeof res === 'object') {
                var msgs = Array.isArray(res.messages) ? res.messages : [];
                var prevLen = chatCache.length;
                chatCache = msgs;
                chatHeader = res.header || chatHeader;
                varCache = (chatHeader && chatHeader.chat_metadata && chatHeader.chat_metadata.variables) || varCache || {};
                return { prevLen: prevLen, len: msgs.length };
            }
            return null;
        });
    }

    function receive(msg) {
        if (!msg || msg.channel !== 'utopinn-panel') return;
        if (msg.direction === 'response') {
            var p = pending[msg.requestId];
            if (!p) return;
            delete pending[msg.requestId];
            if (msg.ok) p.resolve(msg.result);
            else {
                var err = new Error((msg.error && msg.error.message) || 'bridge error');
                err.code = msg.error && msg.error.code;
                p.reject(err);
            }
            return;
        }
        if (msg.direction !== 'push' || !msg.payload) return;
        // 'chat.updated' → refresh snapshot, then re-emit as chat_changed-ish
        if (msg.event === 'chat.updated' || (msg.payload && msg.payload.name === 'chat_changed')) {
            scheduleChatRefresh(50);
        }
        if (msg.event === 'host.event' || msg.event === 'th.event' || msg.event === 'ctx.event') {
            var name = String(msg.payload.name || '');
            var args = Array.isArray(msg.payload.args) ? msg.payload.args : [];
            if (name) dispatchLocal(name, args);
        }
    }

    window.__utopinnPanelReceive = receive;
    if (typeof window.addEventListener === 'function') {
        window.addEventListener('message', function (e) {
            try { receive(typeof e.data === 'string' ? JSON.parse(e.data) : e.data); } catch (_) { /* not ours */ }
        });
    }

    // ── ctx.eventSource (Luker event emitter face) ─────────────────────────
    var eventSource = {
        on: function (event, fn) {
            addListener(ctxListeners, String(event), fn, false);
            request('ctx.on', { event: String(event) }).catch(function () { /* best effort */ });
            return eventSource;
        },
        once: function (event, fn) {
            addListener(ctxListeners, String(event), fn, true);
            request('ctx.on', { event: String(event) }).catch(function () { });
            return eventSource;
        },
        off: function (event, fn) {
            removeListenerEverywhere(String(event), fn);
            request('ctx.off', { event: String(event) }).catch(function () { });
            return eventSource;
        },
        removeListener: function (event, fn) { return eventSource.off(event, fn); },
        emit: function (event) {
            var args = Array.prototype.slice.call(arguments, 1);
            dispatchLocal(String(event), args);
            request('ctx.eventEmit', { name: String(event), args: jsonClone(args) || [] }).catch(function () { });
            return true;
        },
        emitAndWait: function (event) {
            var args = Array.prototype.slice.call(arguments, 1);
            return Promise.all(dispatchLocal(String(event), args).map(function (r) { return Promise.resolve(r); }))
                .then(function (r) {
                    request('ctx.eventEmit', { name: String(event), args: jsonClone(args) || [] }).catch(function () { });
                    return r;
                });
        },
        setMaxListeners: function () { return eventSource; },
    };

    function getMessages() { return chatCache; }

    // ── ctx object (Luker buildContext subset — semantics mirror the
    //    headless host ctxDispatch in apps/cli/cardapp-host.mjs) ────────────
    var ctx = {
        charId: String(BOOTSTRAP.charId || ''),
        assetBase: String(BOOTSTRAP.assetBase || (function () {
            try { return new URL('.', window.location.href).href; } catch (_) { return './'; }
        })()),
        eventSource: eventSource,

        get container() {
            return document.getElementById('card-app-container') || document.body || null;
        },
        get parentDoc() {
            // 沙箱默认同源隔离 → 多半 null;卡 manifest sameOrigin:true 时才有真值。
            try { return window.parent && window.parent !== window ? window.parent.document : null; }
            catch (_) { return null; }
        },
        get dead() { return dead === true; },

        onDispose: function (fn) { if (typeof fn === 'function') disposeCallbacks.push(fn); },

        // ── messages ──
        sendMessage: function (text, options) {
            return request('ctx.sendMessage', { text: String(text == null ? '' : text), options: jsonClone(options) || {} })
                .then(function (r) {
                    scheduleChatRefresh(0);
                    return (r && typeof r === 'object' && 'text' in r) ? r.text : r;
                });
        },
        sendTextareaMessage: function (text) { return ctx.sendMessage(text); },
        getHistory: function (limit, offset) {
            var msgs = getMessages();
            offset = Number(offset) || 0;
            if (limit) {
                var start = Math.max(0, msgs.length - offset - limit);
                return msgs.slice(start, msgs.length - offset);
            }
            return msgs.slice();
        },
        editMessage: function (messageId, newText) {
            return request('ctx.editMessage', { messageId: Number(messageId), text: String(newText == null ? '' : newText) })
                .then(function (r) { scheduleChatRefresh(0); return r; });
        },
        regenerate: function () { return request('ctx.regenerate', {}); },
        swipe: function () { return request('ctx.swipe', {}); },

        // ── variables: getVariable sync-reads the seeded cache ──
        getVariable: function (key) { return varCache ? varCache[key] : undefined; },
        getVariables: function () { return jsonClone(varCache) || {}; },
        setVariable: function (key, value) {
            var v = jsonClone(value);
            if (varCache) varCache[key] = v;
            return request('ctx.setVariable', { key: String(key), value: v }).then(function () { return value; });
        },

        // ── chat_state sidecar (envelope semantics: {ok, state, ...}) ──
        getChatState: function (namespace) {
            return request('ctx.getChatState', { namespace: String(namespace) })
                .then(function (r) {
                    if (r && typeof r === 'object' && 'ok' in r) return r;
                    return { ok: true, state: r == null ? null : r };
                })
                .catch(function (e) { return { ok: false, state: null, reason: 'transport', hint: String(e && e.message || e) }; });
        },
        updateChatState: function (namespace, updater, options) {
            var ns = String(namespace);
            return ctx.getChatState(ns).then(function (cur) {
                var curState = cur && cur.ok ? cur.state : null;
                var next = typeof updater === 'function'
                    ? updater(jsonClone(curState) || {}, { attempt: 0, target: options || {}, namespace: ns })
                    : jsonClone(updater);
                if (next === null || next === undefined) return { ok: true, state: curState, updated: false };
                return request('ctx.updateChatState', { namespace: ns, state: jsonClone(next) || {} });
            }).catch(function (e) { return { ok: false, reason: 'transport', hint: String(e && e.message || e) }; });
        },
        patchChatState: function (namespace, operations) {
            return request('ctx.updateChatState', { namespace: String(namespace), operations: jsonClone(operations) || [] })
                .catch(function (e) { return { ok: false, reason: 'transport', hint: String(e && e.message || e) }; });
        },
        deleteChatState: function (namespace) {
            return request('ctx.deleteChatState', { namespace: String(namespace) })
                .catch(function (e) { return { ok: false, reason: 'transport', hint: String(e && e.message || e) }; });
        },
        getCharacterState: function (namespace) {
            return request('ctx.getCharacterState', { namespace: String(namespace) })
                .then(function (r) { return r && typeof r === 'object' && 'ok' in r ? r : { ok: true, state: r == null ? null : r }; })
                .catch(function (e) { return { ok: false, state: null, reason: 'transport', hint: String(e && e.message || e) }; });
        },
        updateCharacterState: function (namespace, updater) {
            var ns = String(namespace);
            return ctx.getCharacterState(ns).then(function (cur) {
                var curState = cur && cur.ok ? (cur.state || {}) : {};
                var next = typeof updater === 'function' ? updater(jsonClone(curState)) : jsonClone(updater);
                if (next === null || next === undefined) return { ok: true, state: curState, updated: false };
                var merged = {};
                for (var k in curState) merged[k] = curState[k];
                for (var k2 in next) merged[k2] = next[k2];
                return request('ctx.updateCharacterState', { namespace: ns, state: merged });
            }).catch(function (e) { return { ok: false, reason: 'transport', hint: String(e && e.message || e) }; });
        },

        // ── world info (five-source semantics live on the host) ──
        getWorldBooks: function (options) {
            return request('ctx.getWorldBooks', { withSource: !!(options && options.withSource) })
                .then(function (r) { return Array.isArray(r) ? r : []; })
                .catch(function () { return []; });
        },
        getWorldBookEntries: function (name) {
            return request('ctx.getWorldBook', { name: String(name) })
                .catch(function () { return null; });
        },

        // ── slash / prompts ──
        executeSlashCommand: function (command) {
            return request('ctx.executeSlashCommand', { script: String(command == null ? '' : command) });
        },
        setExtensionPrompt: function (key, value, position, depth, scan, role) {
            return request('ctx.setExtensionPrompt', {
                key: String(key), value: String(value == null ? '' : value),
                position: position, depth: depth, scan: !!scan, role: role,
            });
        },

        // ── identity ──
        getCharaFilename: function () { return ctx.charId; },
        getChatId: function () { return String(BOOTSTRAP.chatName || ''); },
        getCharacter: function () { return request('ctx.getCharacter', {}); },

        // ── host chrome / misc ──
        openOverlay: function () { }, closeOverlay: function () { },
        registerRenderer: function (obj) { ctx.__renderer = obj; },
        getRenderer: function () { return ctx.__renderer || null; },
        addEventListener: function (target, event, handler, options) {
            if (target && typeof target.addEventListener === 'function') target.addEventListener(event, handler, options);
            trackedListeners.push({ target: target, event: event, handler: handler });
        },
        setInterval: function (fn, ms) {
            var id = window.setInterval(fn, ms);
            trackedIntervals.push(id);
            return id;
        },
        setTimeout: function (fn, ms) {
            var id = window.setTimeout(fn, ms);
            trackedTimeouts.push(id);
            return id;
        },

        dispose: function () {
            if (dead) return;
            dead = true;
            for (var i = 0; i < trackedIntervals.length; i++) try { window.clearInterval(trackedIntervals[i]); } catch (_) { }
            for (var j = 0; j < trackedTimeouts.length; j++) try { window.clearTimeout(trackedTimeouts[j]); } catch (_) { }
            for (var k = 0; k < trackedListeners.length; k++) {
                var t = trackedListeners[k];
                try { t.target && t.target.removeEventListener && t.target.removeEventListener(t.event, t.handler); } catch (_) { }
            }
            var cbs = disposeCallbacks.slice(); disposeCallbacks.length = 0;
            for (var c = 0; c < cbs.length; c++) try { cbs[c](); } catch (e) { console.warn('[ctx-shim] onDispose threw', e); }
            return request('ctx.dispose', {}).catch(function () { });
        },
    };

    // ── lukerContext (Luker getContext() face; getters stay live) ─────────
    var lukerContext = {
        get chat() { return getMessages(); },
        get chatId() { return String(BOOTSTRAP.chatName || ''); },
        get characterId() { return ctx.charId; },
        get name2() { return ctx.charId; },
        eventTypes: {
            GENERATION_STARTED: 'generation_started',
            GENERATION_ENDED: 'generation_ended',
            GENERATION_STOPPED: 'generation_stopped',
            GENERATION_WORLD_INFO_FINALIZED: 'generation_world_info_finalized',
            CHARACTER_MESSAGE_RENDERED: 'char_message_rendered',
            USER_MESSAGE_RENDERED: 'user_message_rendered',
            MESSAGE_SENT: 'message_sent',
            MESSAGE_RECEIVED: 'message_received',
            MESSAGE_SWIPED: 'message_swiped',
            MESSAGE_EDITED: 'message_edited',
            MESSAGE_DELETED: 'message_deleted',
            MESSAGE_UPDATED: 'message_updated',
            CHAT_CHANGED: 'chat_changed',
        },
        extension_prompt_types: { IN_PROMPT: 0, IN_CHAT: 1, NONE: -1, BEFORE_PROMPT: 2 },
        eventSource: eventSource,
        setExtensionPrompt: function (key, value, position, depth, scan, role) {
            return ctx.setExtensionPrompt(key, value, position, depth, scan, role);
        },
        worldInfoEntry: {
            getSorted: function () {
                return ctx.getWorldBooks({}).then(function (books) {
                    var names = (Array.isArray(books) ? books : []).map(function (b) {
                        return typeof b === 'string' ? b : (b && b.name);
                    }).filter(Boolean);
                    return Promise.all(names.map(function (n) { return ctx.getWorldBookEntries(n); }))
                        .then(function (docs) {
                            var all = [];
                            docs.forEach(function (doc) {
                                var entries = doc && doc.entries && typeof doc.entries === 'object'
                                    ? Object.keys(doc.entries).map(function (k) { return doc.entries[k]; })
                                    : (Array.isArray(doc) ? doc : []);
                                for (var i = 0; i < entries.length; i++) all.push(entries[i]);
                            });
                            all.sort(function (a, b) {
                                return Number(a && (a.order != null ? a.order : a.insertion_order) || 0)
                                    - Number(b && (b.order != null ? b.order : b.insertion_order) || 0);
                            });
                            return all;
                        });
                });
            },
        },
        is_send_press: false,
        generate: function (type) { return request('ctx.generate', { type: String(type || 'normal') }); },
        getContext: function () { return lukerContext; },
    };
    ctx.lukerContext = lukerContext;

    // TH-style listener face reused by ctx cards that also listen on
    // 'message_received' etc. via the legacy registry — same dispatch pool.
    ctx.__listeners = listeners;

    // ── lifecycle: seed caches before init(ctx) runs ──────────────────────
    ctx.__ready = (function () {
        if (!NONCE) return Promise.reject(new Error('missing mount nonce'));
        return refreshChat();
    })();

    window.__CARDAPP_CTX__ = ctx;
})();
