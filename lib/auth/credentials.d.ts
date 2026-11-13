import type { WebOptions } from '../store.js';
export declare function hashPassword(password: string, salt: string): string;
export declare function setHashedPassword(options: WebOptions, password: string): void;
export declare function verifyPassword(password: string, options: WebOptions): boolean;
