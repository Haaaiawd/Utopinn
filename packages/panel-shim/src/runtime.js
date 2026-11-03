/**
 * Uberge panel shim — TavernHelper-compatible T0 face.
 * Injected into the card sandbox (RN WebView / iframe). Speaks the
 * 'uberge-panel' postMessage protocol to the host; never touches the
 * network or host DOM directly.
 *
 * Host contract:
 *   out: {channel:'uberge-panel',direction:'request',nonce,requestId,method,args}
 *   in : window.__ubergePanelReceive({direction:'response'|'push',...})
 *        (also accepts 'message' events carrying the same envelope)
 *   bootstrap: window.__UBERGE_PANEL_NONCE__ + window.__UBERGE_PANEL_BOOTSTRAP__
 */
(function () {
    'use strict';

    var NONCE = (typeof window.__UBERGE_PANEL_NONCE__ === 'string') ? window.__UBERGE_PANEL_NONCE__ : '';
    var BOOTSTRAP = window.__UBERGE_PANEL_BOOTSTRAP__ || {};

    var pending = {};
    var seq = 0;
    var listeners = {}; // event -> [{fn, once}]
    var localGlobals = {}; // initializeGlobal'd names

    // ── transport ─────────────────────────────────────────────────────────
    function post(msg) {
        if (typeof window.__ubergePanelPost === 'function') { window.__ubergePanelPost(msg); return; }
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
                post({ channel: 'uberge-panel', direction: 'request', nonce: NONCE, requestId: id, method: method, args: args || {} });
            } catch (e) {
                delete pending[id];
                reject(e);
            }
        });
    }

    function receive(msg) {
        if (!msg || msg.channel !== 'uberge-panel') return;
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

    window.__ubergePanelReceive = receive;
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
        (listeners[name] = listeners[name] || []).push({ fn: fn, once: !!once });
    }

    function removeListener(name, fn) {
        var list = listeners[name] || [];
        for (var i = list.length - 1; i >= 0; i--) if (list[i].fn === fn) list.splice(i, 1);
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
            return request('th.replaceVariables', Object.assign(scopeArgs(o), { variables: variables }));
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

        // events — callbacks live here; the host only tracks which events to forward
        eventOn: function (event, fn) {
            addListener(event, fn, false);
            request('th.eventOn', { event: event });
            return function stop() { api.eventRemoveListener(event, fn); };
        },
        eventOnce: function (event, fn) {
            addListener(event, fn, true);
            request('th.eventOnce', { event: event });
            return function stop() { removeListener(event, fn); };
        },
        eventRemoveListener: function (event, fn) {
            removeListener(event, fn);
            return request('th.eventRemoveListener', { event: event });
        },
        eventEmit: function (event) {
            var args = Array.prototype.slice.call(arguments, 1);
            dispatchLocal(event, args);
            return request('th.eventEmit', { event: event, args: args });
        },
        eventEmitAndWait: function (event) {
            var args = Array.prototype.slice.call(arguments, 1);
            dispatchLocal(event, args);
            return request('th.eventEmitAndWait', { event: event, args: args });
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
