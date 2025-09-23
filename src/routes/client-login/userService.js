import { supabase } from '../../lib/supabaseClient';
import { getCurrentUser, canViewAllUsers, getClientIdForFiltering } from './userUtils';
import { sortUsers } from '../../lib/utils/userSorting';

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
        let usersQuery = supabase.from('end_users').select('*');
        
        // If the user is not alara_admin, filter by client_id
        if (!canViewAllUsers(currentUser)) {
            const clientId = getClientIdForFiltering(currentUser);
            
            if (clientId) {
                usersQuery = usersQuery.eq('client_id', clientId);
                console.log(`Filtering users by client_id: ${clientId}`);
            } else {
                console.warn('No client_id found for filtering, returning empty array');
                return [];
            }
        } else {
            console.log('Super admin access - showing all users');
        }
        
        const { data: users, error: usersError } = await usersQuery;
        
        if (usersError) {
            console.error('Error fetching users:', usersError);
            throw usersError;
        }
        
        if (!users || users.length === 0) {
            console.log('No users found');
            return [];
        }
        
        // Get last message time for all users in one optimized query
        const userIds = users.map(user => user.id);
        console.log(`Fetching last message times for ${userIds.length} users`);
        
        // Get the latest message for each user using a more efficient query
        // This uses a raw SQL query approach with Supabase's built-in PostgreSQL features
        const { data: messagesData, error: messagesError } = await supabase
            .from('messages')
            .select('end_user_id, time')
            .in('end_user_id', userIds)
            .order('time', { ascending: false });
            
        if (messagesError) {
            console.error('Error fetching messages:', messagesError);
            // continue without message times, but with a warning
            console.warn('Continuing without message times due to error');
        }
        
        // Create a map of last messages for each user
        const lastMessageMap = new Map();
        if (messagesData) {
            // Since we ordered by time descending, the first message for each user is the latest
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
        const sortedUsers = sortUsers(processedUsers);
        
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