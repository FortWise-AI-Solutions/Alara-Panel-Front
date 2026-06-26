/**
 * Supabase/PostgREST returns at most `max-rows` (1000 by default) rows per
 * request, silently truncating larger result sets. This helper transparently
 * paginates a query with `.range()` so that ALL matching rows are returned.
 *
 * Usage:
 *   const rows = await fetchAllRows((from, to) =>
 *     supabase.from('messages').select('*').eq('end_user_id', id).range(from, to)
 *   );
 *
 * The callback is invoked once per page and must apply `.range(from, to)` to a
 * freshly built query so each page hits the database independently.
 */
export const SUPABASE_PAGE_SIZE = 1000;

export async function fetchAllRows<T = any>(
    buildQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>,
    pageSize: number = SUPABASE_PAGE_SIZE
): Promise<T[]> {
    const all: T[] = [];
    let from = 0;

    // Loop until a page comes back shorter than the page size, which means we
    // have reached the end of the result set.
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const to = from + pageSize - 1;
        const { data, error } = await buildQuery(from, to);

        if (error) {
            throw error;
        }

        if (!data || data.length === 0) {
            break;
        }

        all.push(...data);

        if (data.length < pageSize) {
            break;
        }

        from += pageSize;
    }

    return all;
}
