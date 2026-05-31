import { createContext, useContext, useEffect, useState, useRef } from 'react';
import { authWeb } from '../integrations/backend/backendClient';

const NoCodeContext = createContext();

export const NoCodeProvider = ({ children }) => {
    // In dev mode, skip nocode platform auth entirely (uses local sync)
    const [isReady, setIsReady] = useState(import.meta.env.DEV);
    const [user, setUser] = useState(null);
    const initializedRef = useRef(false);

    useEffect(() => {
        if (initializedRef.current) return;
        initializedRef.current = true;

        const initializeAuth = async () => {
            if (isReady) return;

            const timeout = new Promise(resolve => setTimeout(() => resolve({ render: true, _timedOut: true }), 3000));

            try {
                const result = await Promise.race([authWeb.login(), timeout]);
                if (result?.render) {
                    if (result.token) {
                        const userInfo = await authWeb.getUserInfo();
                        if (!userInfo.user) {
                            logout();
                            return;
                        }
                        setUser({
                            identity: userInfo.user.auth_identity,
                            name: userInfo.user.name,
                            avatarUrl: userInfo.user.avatar_url || '',
                            email: userInfo.user.email || ''
                        });
                    }
                    setIsReady(true);
                }
            } catch (err) {
                console.error('认证初始化失败:', err);
                setIsReady(true);
            }
        };

        initializeAuth();
    }, []);

    const logout = async () => {
        try {
            await authWeb.logout();
            setUser(null);
            setIsReady(false);
            initializedRef.current = false;
            window.location.reload();
        } catch (err) {
            console.error('退出登录失败:', err);
            throw err;
        }
    };

    const value = {
        isReady,
        user,
        logout
    };

    return (
        <NoCodeContext.Provider value={value}>
            {isReady ? children : ""}
        </NoCodeContext.Provider>
    );
};

// 自定义hook
export const useNoCode = () => {
    const context = useContext(NoCodeContext);
    if (!context) {
        throw new Error('useNoCode必须在NoCodeProvider内部使用');
    }
    return context;
};

export default NoCodeContext;
