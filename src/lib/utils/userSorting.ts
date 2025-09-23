import type { User } from "../types/type";

interface UserWithSortData extends User {
    unreadCount?: number;
    alara_status?: boolean;
    human_required?: boolean;
    lastMessageTime?: Date | null;
}

/**
 * Determines user status based on human_required and alara_status flags
 */
export function getUserStatus(user: UserWithSortData): string {
    // Human required status takes highest priority
    if (user.human_required === true) {
        return "human-required";
    }
    
    // Then check alara_status
    if (user.alara_status === true) {
        return "online";
    } else if (user.alara_status === false) {
        return "offline";
    }
    
    // Default if no status information available
    return "no-info";
}

/**
 * Centralized sorting function for users
 * Prioritizes:
 * 1. Human Required users first
 * 2. Users with recent messages (sorted by last message time)
 * 3. Users with unread messages (sorted by count)
 * 4. Alphabetically by name as fallback
 */
export function sortUsers(users: UserWithSortData[]): UserWithSortData[] {
    return [...users].sort((a, b) => {
        const aUnread = a.unreadCount || 0;
        const bUnread = b.unreadCount || 0;
        const aStatus = getUserStatus(a);
        const bStatus = getUserStatus(b);

        // HIGHEST PRIORITY: Users with human_required status always first
        const aHumanRequired = aStatus === "human-required";
        const bHumanRequired = bStatus === "human-required";

        if (aHumanRequired && !bHumanRequired) return -1;
        if (!aHumanRequired && bHumanRequired) return 1;

        // Second priority: Last message time (newer at the top)
        // Use lastMessageTime directly from the user object (from Supabase)
        if (a.lastMessageTime && b.lastMessageTime) {
            return b.lastMessageTime.getTime() - a.lastMessageTime.getTime();
        }
        
        // Users with messages have priority over those without
        if (a.lastMessageTime && !b.lastMessageTime) return -1;
        if (!a.lastMessageTime && b.lastMessageTime) return 1;
        
        // Third priority: Users with unread messages
        if (aUnread > 0 && bUnread === 0) return -1;
        if (bUnread > 0 && aUnread === 0) return 1;
        
        // Among users with unread messages - by count (more = higher)
        if (aUnread > 0 && bUnread > 0) {
            return bUnread - aUnread;
        }

        // If everything else is equal, sort by name
        const aName = a.nickname || a.name || a.username || "";
        const bName = b.nickname || b.name || b.username || "";
        return aName.localeCompare(bName);
    });
}