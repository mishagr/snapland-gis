/**
 * Header set by server.ts from the socket address (client-supplied values are
 * overwritten). Lives in its own module so server.ts does not import `next/server`
 * before Next has initialised its runtime.
 */
export const CLIENT_IP_HEADER = 'x-snapland-client-ip';
