// React binding for the connection session (baseUrl / connectivity).
// useSyncExternalStore over the ServerSession listener set — no extra deps.
import { useSyncExternalStore } from 'react';
import { session } from '../api/session';

export function useSession(): typeof session {
    useSyncExternalStore(session.subscribe, () => session.conn + '|' + session.baseUrl + '|' + session.loaded + '|' + session.handle);
    return session;
}
