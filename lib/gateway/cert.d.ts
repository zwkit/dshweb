export interface TlsLoadResult {
    cert: string;
    key: string;
    source: 'generated' | 'user' | 'cache';
    notAfter?: string;
}
export declare function loadOrCreateTlsCredentials(args: {
    dir: string;
    certPath?: string;
    keyPath?: string;
    logger?: any;
}): TlsLoadResult;
