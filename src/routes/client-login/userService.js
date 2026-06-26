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

        // Paginate so we load EVERY user. Without this, Supabase caps the
        // result at 1000 rows and newer users (e.g. a fresh booking's
        // end_user) silently never appear in the panel. Order by id so the
        // .range() paging is stable across pages.
        const users = await fetchAllRows((from, to) => {
            let usersQuery = supabase
                .from('end_users')
                .select('*')
                .order('id', { ascending: true });

            if (filterClientId) {
                usersQuery = usersQuery.eq('client_id', filterClientId);
            }

            return usersQuery.range(from, to);
        });

        if (!users || users.length === 0) {
            console.log('No users found');
            return [];
        }
        
        // get last message time for all users in one query
        const userIds = users.map(user => user.id);
        console.log(`Fetching last message times for ${userIds.length} users`);
        
        // Fetch all messages for these users. Two limits to respect:
        //  1. A single request returns at most 1000 rows -> paginate with range().
        //  2. A huge .in(...) list bloats the request URL past the gateway limit
        //     -> chunk the user ids so each request stays small.
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