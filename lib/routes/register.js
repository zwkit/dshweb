/**
 * 将 dshweb 路由注册到 DSH WebServer（遵循 DSH 底座 WebRoute 契约）
 */
export function registerWebRoutes(ctx, routes) {
    const webServer = ctx?.webServer;
    if (!webServer || typeof webServer.register !== 'function') {
        return;
    }
    const registerAll = () => {
        const disposers = [];
        try {
            for (const route of routes) {
                const dispose = webServer.register({
                    ...route,
                    kind: route.kind ?? 'exact',
                });
                if (typeof dispose === 'function') {
                    disposers.push(dispose);
                }
            }
        }
        catch (error) {
            for (const dispose of disposers.reverse()) {
                try {
                    dispose();
                }
                catch { }
            }
            throw error;
        }
        return () => {
            for (const dispose of disposers.reverse()) {
                try {
                    dispose();
                }
                catch { }
            }
        };
    };
    if (typeof ctx.effect === 'function') {
        ctx.effect(() => registerAll(), 'dshweb:web-routes');
    }
    else {
        try {
            const d = registerAll();
            if (typeof d === 'function')
                ctx.on?.('dispose', d);
        }
        catch { }
    }
}
