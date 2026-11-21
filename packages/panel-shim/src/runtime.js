/**
 * Utopinn panel shim — TavernHelper-compatible T0 face.
 * Injected into the card sandbox (RN WebView / iframe). Speaks the
 * 'utopinn-panel' postMessage protocol to the host; never touches the
 * network or host DOM directly.
 *
 * Host contract:
 *   out: {channel:'utopinn-panel',direction:'request',nonce,requestId,method,args}
 *   in : window.__utopinnPanelReceive({direction:'response'|'push',...})
 *        (also accepts 'message' events carrying the same envelope)
 *   bootstrap: window.__UTOPINN_PANEL_NONCE__ + window.__UTOPINN_PANEL_BOOTSTRAP__
 */
(function () {
    'use strict';

    var NONCE = (typeof window.__UTOPINN_PANEL_NONCE__ === 'string') ? window.__UTOPINN_PANEL_NONCE__ : '';
    var BOOTSTRAP = window.__UTOPINN_PANEL_BOOTSTRAP__ || {};

    var pending = {};
    var seq = 0;
    var listeners = {}; // event -> [{fn, once, lid}]
    var lidSeq = 0;
    // realm 随机段:不同 mount 的 lid 天然不撞(影子注册表按 lid upsert)
    var realmTag = Math.random().toString(36).slice(2, 8);
    var localGlobals = {}; // initializeGlobal'd names

    // ── transport ─────────────────────────────────────────────────────────
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

    function receive(msg) {
        if (!msg || msg.channel !== 'utopinn-panel') return;
        if (msg.direction === 'response') {
            var p = pending[msg.requestId];
            if (!p) return;
            delete pending[msg.requestId];
            if (msg.ok) p.resolve(msg.result);
            else p.reject(new Error((msg.error && msg.error.message) || 'bridge error'));
            return;
        }
        if (msg.direction === 'push' && msg.event === 'th.event' && msg.payload) {
            dispatchLocal(msg.payload.name, msg.payload.args || []);
        }
    }

    window.__utopinnPanelReceive = receive;
    if (typeof window.addEventListener === 'function') {
        window.addEventListener('message', function (e) {
            try { receive(typeof e.data === 'string' ? JSON.parse(e.data) : e.data); } catch (_) { /* not ours */ }
        });
    }

    // ── local event registry ─────────────────────────────────────────────
    function dispatchLocal(name, args) {
        var list = (listeners[name] || []).slice();
        var results = [];
        for (var i = 0; i < list.length; i++) {
            var entry = list[i];
            try { results.push(entry.fn.apply(null, args)); } catch (e) { console.warn('[panel-shim] listener threw', e); }
            if (entry.once) removeListener(name, entry.fn);
        }
        return results;
    }

    function addListener(name, fn, once) {
        var lid = 'l' + (++lidSeq) + '.' + realmTag;
        (listeners[name] = listeners[name] || []).push({ fn: fn, once: !!once, lid: lid });
        return lid;
    }

    function removeListener(name, fn) {
        var list = listeners[name] || [];
        for (var i = list.length - 1; i >= 0; i--) if (list[i].fn === fn) list.splice(i, 1);
    }

    /** 找该 event 下 fn 的(最后一个)注册项 —— 用于 lid 定位与 make* 重排。 */
    function findEntry(name, fn) {
        var list = listeners[name] || [];
        for (var i = list.length - 1; i >= 0; i--) if (list[i].fn === fn) return { list: list, index: i, entry: list[i] };
        return null;
    }

    // ── API surface ───────────────────────────────────────────────────────
    function scopeArgs(o) {
        o = o || {};
        return { type: o.type, message_id: o.message_id, script_id: o.script_id };
    }

    var api = {
        // variables
        getVariables: function (o) { return request('th.getVariables', scopeArgs(o)); },
        replaceVariables: function (variables, o) {
            // force:true 显式确认丢根全量覆盖(GH#4 护栏逃生门)
            return request('th.replaceVariables', Object.assign(scopeArgs(o),
                { variables: variables, force: o && o.force === true ? true : undefined }));
        },
        insertOrAssignVariables: function (variables, o) {
            return request('th.insertOrAssignVariables', Object.assign(scopeArgs(o), { variables: variables }));
        },
        insertVariables: function (variables, o) {
            return request('th.insertVariables', Object.assign(scopeArgs(o), { variables: variables }));
        },
        updateVariablesWith: function (updater, o) {
            // updater is a function — evaluate locally, ship the result
            return api.getVariables(o).then(function (vars) {
                var next = updater(vars);
                return request('th.updateVariablesWith', Object.assign(scopeArgs(o), { result: next }));
            });
        },
        deleteVariable: function (path, o) {
            return request('th.deleteVariable', Object.assign(scopeArgs(o), { path: path }));
        },

        // events — callbacks live here; the host tracks which events to forward
        // (push filter) and mirrors the ops into the server th.events shadow.
        eventOn: function (event, fn) {
            var lid = addListener(event, fn, false);
            request('th.eventOn', { event: event, listener_id: lid });
            return function stop() { api.eventRemoveListener(event, fn); };
        },
        eventOnce: function (event, fn) {
            var lid = addListener(event, fn, true);
            request('th.eventOnce', { event: event, listener_id: lid });
            return function stop() { api.eventRemoveListener(event, fn); };
        },
        eventMakeLast: function (event, fn) {
            var f = findEntry(event, fn);
            if (f) { f.list.splice(f.index, 1); f.list.push(f.entry); }
            return request('th.eventMakeLast', { event: event, listener_id: f && f.entry.lid });
        },
        eventMakeFirst: function (event, fn) {
            var f = findEntry(event, fn);
            if (f) { f.list.splice(f.index, 1); f.list.unshift(f.entry); }
            return request('th.eventMakeFirst', { event: event, listener_id: f && f.entry.lid });
        },
        eventRemoveListener: function (event, fn) {
            var f = findEntry(event, fn);
            removeListener(event, fn);
            return request('th.eventRemoveListener', { event: event, listener_id: f && f.entry.lid });
        },
        eventClearEvent: function (event) {
            delete listeners[event];
            return request('th.eventClearEvent', { event: event });
        },
        eventClearListener: function (fn) {
            var lids = [];
            for (var ev in listeners) {
                var f = findEntry(ev, fn);
                if (f) { lids.push(f.entry.lid); removeListener(ev, fn); }
            }
            return request('th.eventClearListener', { listener_ids: lids });
        },
        eventClearAll: function () {
            listeners = {};
            return request('th.eventClearAll', {});
        },
        eventEmit: function (event) {
            var args = Array.prototype.slice.call(arguments, 1);
            dispatchLocal(event, args);
            return request('th.eventEmit', { event: event, args: args });
        },
        eventEmitAndWait: function (event) {
            var args = Array.prototype.slice.call(arguments, 1);
            var results = dispatchLocal(event, args);
            return request('th.eventEmitAndWait', { event: event, args: args })
                .then(function () { return Promise.all(results.map(function (r) { return Promise.resolve(r); })); });
        },

        // messages
        getChatMessages: function (range, o) {
            o = o || {};
            return request('th.getChatMessages', {
                range: range, role: o.role, hide_state: o.hide_state, include_swipes: o.include_swipes,
            });
        },
        getLastMessageId: function () { return request('th.getLastMessageId'); },
        getCurrentMessageId: function () {
            if (typeof BOOTSTRAP.messageId === 'number') return Promise.resolve(BOOTSTRAP.messageId);
            return request('th.getCurrentMessageId');
        },

        // injected prompts
        injectPrompts: function (prompts) { return request('th.injectPrompts', { prompts: prompts }); },
        uninjectPrompts: function (ids) { return request('th.uninjectPrompts', { ids: ids }); },

        // globals
        waitGlobalInitialized: function (name, timeoutMs) {
            var deadline = Date.now() + (timeoutMs || 15000);
            return new Promise(function (resolve, reject) {
                (function poll() {
                    if (typeof window[name] !== 'undefined') return resolve(window[name]);
                    if (typeof localGlobals[name] !== 'undefined') return resolve(localGlobals[name]);
                    if ((BOOTSTRAP.initializedGlobals || []).indexOf(name) !== -1 && typeof window[name] !== 'undefined') {
                        return resolve(window[name]);
                    }
                    if (Date.now() > deadline) return reject(new Error('waitGlobalInitialized timeout: ' + name));
                    setTimeout(poll, 50);
                })();
            }).then(function (g) { return g; }, function (e) {
                // last resort: ask the host (server-side capability may satisfy it)
                return request('th.waitGlobalInitialized', { name: name }).then(function (ok) {
                    if (ok && typeof window[name] !== 'undefined') return window[name];
                    throw e;
                });
            });
        },
        initializeGlobal: function (name, value) {
            localGlobals[name] = value;
            return request('th.initializeGlobal', { name: name });
        },

        // identity
        getCharacter: function () { return request('th.getCharacter'); },
        getCurrentCharacterName: function () { return request('th.getCurrentCharacterName'); },

        // auxiliary generation (GH#9): independent quiet-chain generate — does NOT
        // append a chat message. TH 契约返回 text;详细回执走 detail 形。
        generate: function (config) {
            return request('th.generate', config || {}).then(function (r) {
                return (r && typeof r === 'object' && 'text' in r) ? r.text : r;
            });
        },
        generateRaw: function (config) {
            return request('th.generateRaw', config || {}).then(function (r) {
                return (r && typeof r === 'object' && 'text' in r) ? r.text : r;
            });
        },
    };

    // TH exposes both TavernHelper.* and bare globals inside card iframes.
    window.TavernHelper = api;
    var bareNames = Object.keys(api);
    for (var i = 0; i < bareNames.length; i++) {
        var n = bareNames[i];
        if (typeof window[n] === 'undefined') window[n] = api[n];
    }

    // event-name constants (subset matching protocol TH_TAVERN_EVENTS_T0)
    window.tavern_events = window.tavern_events || {
        MESSAGE_SENT: 'message_sent',
        MESSAGE_RECEIVED: 'message_received',
        MESSAGE_SWIPED: 'message_swiped',
        MESSAGE_EDITED: 'message_edited',
        MESSAGE_DELETED: 'message_deleted',
        MESSAGE_UPDATED: 'message_updated',
        CHAT_CHANGED: 'chat_changed',
        GENERATION_STARTED: 'generation_started',
        GENERATION_STOPPED: 'generation_stopped',
        GENERATION_ENDED: 'generation_ended',
        CHARACTER_MESSAGE_RENDERED: 'char_message_rendered',
        USER_MESSAGE_RENDERED: 'user_message_rendered',
        MORE_MESSAGES_LOADED: 'more_messages_loaded',
    };
    window.iframe_events = window.iframe_events || {
        GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS',
        GENERATION_STARTED: 'GENERATION_STARTED',
        GENERATION_ENDED: 'GENERATION_ENDED',
        BEFORE_MESSAGE_DELETED: 'BEFORE_MESSAGE_DELETED',
        MESSAGE_EDITED: 'MESSAGE_EDITED',
        MESSAGE_RECEIVED: 'MESSAGE_RECEIVED',
    };
})();
