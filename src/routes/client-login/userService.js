import { supabase } from '../../lib/supabaseClient';
import { getCurrentUser, canViewAllUsers, getClientIdForFiltering } from './userUtils';
import { sortUsersBackend } from '../../lib/utils/userSorting';
import { fetchAllRows } from '../../lib/utils/fetchAll';

/**
 * @typedef {Object} User
 * @property {string} id
 * @property {number} client_id
 * @property {string} nickname
 * @property {string} platform
 * @property {string} status
 * @property {string} [external_id]
 * @property {string} [name]
 * @property {string} [username]
 * @property {string} [chat_id]
 * @property {string} [role]
 * @property {string} [created_at]
 */

/**
 * @typedef {Object} CurrentUserInfo
 * @property {number} id
 * @property {string} name
 * @property {string} [email]
 * @property {'alara_admin'|'user_admin'|'client_admin'} role
 * @property {'panel_admins'|'clients'|'client_users'} table
 * @property {number|null} client_id
 * @property {boolean} canViewAllUsers
 */

/**
 * Отримує користувачів з урахуванням ролі поточного користувача
 * @returns {Promise<User[]>} Масив користувачів
 */
export async function getFilteredUsers() {
    const currentUser = getCurrentUser();
    
    if (!currentUser) {
        throw new Error('User not authenticated');
    }
    
    console.log('Current user:', currentUser);
    
    try {
        // Resolve the client_id filter (if any) before paginating.
        let filterClientId = null;
        if (!canViewAllUsers(currentUser)) {
            filterClientId = getClientIdForFiltering(currentUser);

            if (filterClientId) {
                console.log(`Filtering users by client_id: ${filterClientId}`);
            } else {
                console.warn('No client_id found for filtering, returning empty array');
                return [];
            }
        } else {
            console.log('Super admin access - showing all users');
        }

        // Load the FRESHEST leads first. end_users.id is an auto-incrementing
        // integer, so the highest id is the newest lead. Ordering by id
        // DESCENDING guarantees brand-new bookings show up immediately instead
        // of landing on the last page (where they were silently dropped when
        // the query degraded). We still paginate past Supabase's 1000-row cap,
        // but bound the total to MAX_USERS so the panel stays fast and reliable
        // as the table grows. Older conversations beyond this window are lower
        // priority and intentionally not loaded.
        const MAX_USERS = 5000;
        const users = await fetchAllRows((from, to) => {
            let usersQuery = supabase
                .from('end_users')
                .select('*')
                .order('id', { ascending: false });

            if (filterClientId) {
                usersQuery = usersQuery.eq('client_id', filterClientId);
            }

            // Never request past the MAX_USERS ceiling. Short-circuit once we
            // reach it so the paginator terminates cleanly instead of issuing
            // an out-of-range request.
            if (from >= MAX_USERS) {
                return Promise.resolve({ data: [], error: null });
            }
            return usersQuery.range(from, Math.min(to, MAX_USERS - 1));
        });

        if (!users || users.length === 0) {
            console.log('No users found');
            return [];
        }
        
        // get last message time for all users in one query
        const userIds = users.map(user => user.id);
        console.log(`Fetching last message times for ${userIds.length} users`);
        
        // Fetch recent messages to order users by last-message time. Limits:
        //  1. A single request returns at most 1000 rows -> paginate with range().
        //  2. A huge .in(...) list bloats the request URL past the gateway limit
        //     -> chunk the user ids so each request stays small.
        //  3. The messages table grows without bound; scanning ALL of it on
        //     every 2s refresh is what made fresh leads fail to load. Restrict
        //     to a recent window so this query stays cheap. Users whose last
        //     message predates the window simply fall back to created_at order
        //     (they're old conversations, which are lower priority).
        const RECENT_WINDOW_DAYS = 90;
        const recentCutoff = new Date(
            Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000
        ).toISOString();
        let messagesData = [];
        try {
            const ID_CHUNK_SIZE = 200;
            for (let i = 0; i < userIds.length; i += ID_CHUNK_SIZE) {
                const idChunk = userIds.slice(i, i + ID_CHUNK_SIZE);
                const chunkMessages = await fetchAllRows((from, to) =>
                    supabase
                        .from('messages')
                        .select('end_user_id, time')
                        .in('end_user_id', idChunk)
                        .gte('time', recentCutoff)
                        .order('end_user_id')
                        .order('time', { ascending: false })
                        .range(from, to)
                );
                messagesData.push(...chunkMessages);
            }
        } catch (messagesError) {
            console.error('Error fetching messages:', messagesError);
            // continue without message times, but with a warning
            console.warn('Continuing without message times due to error');
        }

        // create a map of last messages (only the first message for each user through ORDER BY)
        const lastMessageMap = new Map();
        if (messagesData) {
            messagesData.forEach(msg => {
                if (!lastMessageMap.has(msg.end_user_id)) {
                    lastMessageMap.set(msg.end_user_id, new Date(msg.time));
                }
            });
        }
        
        // process users with last message time
        const processedUsers = users.map(user => ({
            ...user,
            lastMessageTime: lastMessageMap.get(user.id) || null
        }));
        
        // Use centralized sorting function from userSorting.ts
        const sortedUsers = sortUsersBackend(processedUsers);
        
        return sortedUsers;
        
    } catch (error) {
        console.error('Error in getFilteredUsers:', error);
        throw error;
    }
}

/**
 * Отримує інформацію про поточного користувача для відображення в UI
 * @returns {CurrentUserInfo|null}
 */
export function getCurrentUserInfo() {
    const user = getCurrentUser();
    if (!user) return null;
    
    return {
        id: user.id,
        name: user.name,
        email: user.email || undefined,
        role: user.role,
        table: user.table,
        client_id: user.client_id || null,
        canViewAllUsers: canViewAllUsers(user)
    };
}