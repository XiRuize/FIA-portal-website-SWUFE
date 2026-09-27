/**
 * 会话状态（AuthProvider / useAuth）。
 *
 * 为什么不复用 `store.tsx` 的 ContentProvider：
 * 两者生命周期不同。内容数据是「站点配置类」信息，加载一次可长期缓存；
 * 而会话状态需要**在每次路由切换前被确认**（守卫要用它做判定），
 * 且必须在 401 时能立即清除。混在一起的后果是「退出登录后内容缓存还带着管理态」。
 *
 * 关键约束：前端的状态只是**镜像**，真正的权限判定在后端。
 * 前端守卫的作用是「别让用户白跑一趟」，不是安全边界。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, authApi, type Account, type Capability, type Identity, type Role } from './backendApi';

export type { Account, Capability, Identity, Role };

/** 会话检查状态 */
export type AuthStatus =
  | 'checking' // 首次加载，正在向后端确认
  | 'authenticated'
  | 'guest' // 确认未登录
  | 'offline'; // 后端不可达 —— 与「未登录」区分，便于给出准确提示

interface AuthContextValue {
  status: AuthStatus;
  account: Account | null;
  role: Role | 'guest';
  capabilities: Capability[];
  /** 后端不可达时的错误信息 */
  error: string | null;
  /** 是否已登录 */
  authenticated: boolean;
  /** 是否具备某项能力 */
  can: (capability: Capability) => boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** 重新向后端确认会话（路由切换、登录后、窗口聚焦时调用） */
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** 未登录时的空身份 */
const GUEST_IDENTITY: Identity = {
  authenticated: false,
  role: 'guest',
  account: null,
  capabilities: [],
  expiresAt: null,
  expiresInSec: null,
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('checking');
  const [identity, setIdentity] = useState<Identity>(GUEST_IDENTITY);
  const [error, setError] = useState<string | null>(null);

  // 并发去重：路由切换 + 窗口聚焦可能同时触发 refresh，
  // 若不加锁会打出多个相同请求（并可能因乱序返回而把状态写回旧的）。
  const inflight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    if (inflight.current) return inflight.current;

    const task = (async () => {
      try {
        const me = await authApi.me();
        setIdentity(me);
        setStatus(me.authenticated ? 'authenticated' : 'guest');
        setError(null);
      } catch (err) {
        // 后端不可达与会话失效是两回事，必须区分：
        // 前者要提示「服务未启动」，后者只是「没登录」。
        if (err instanceof ApiError && err.code === 'NETWORK_ERROR') {
          setIdentity(GUEST_IDENTITY);
          setStatus('offline');
          setError(err.message);
        } else {
          // 其它异常按未登录处理，但不覆盖错误提示（多半是网络抖动）
          setIdentity(GUEST_IDENTITY);
          setStatus('guest');
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        inflight.current = null;
      }
    })();

    inflight.current = task;
    return task;
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    await authApi.login(username, password);
    // 登录成功后立刻以服务端返回为准刷新身份，不自行猜测角色
    inflight.current = null;
    await refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      // 无论后端是否响应成功，本地都必须回到访客态，
      // 否则会出现「点了退出但界面还是管理后台」的错觉。
      setIdentity(GUEST_IDENTITY);
      setStatus('guest');
      inflight.current = null;
    }
  }, []);

  // 首次挂载时确认会话
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 窗口重新聚焦时校验会话：临时账号可能已过期，标签页却还开着
  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [refresh]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      account: identity.account,
      role: identity.role,
      capabilities: identity.capabilities,
      error,
      authenticated: status === 'authenticated',
      can: (capability: Capability) => identity.capabilities.includes(capability),
      login,
      logout,
      refresh,
    }),
    [status, identity, error, login, logout, refresh]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** 读取会话状态。必须在 AuthProvider 内使用。 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 <AuthProvider> 内使用');
  return ctx;
}

// ---------------------------------------------------------------------------
// 能力常量与便捷判断
// ---------------------------------------------------------------------------

/** 能看受限资料（研发部内部资料等） */
export const CAP_VIEW_RESTRICTED = 'canViewRestricted';
/** 能管理内容（文章、时间线、组织架构） */
export const CAP_MANAGE_CONTENT = 'canManageContent';
/** 能管理账号 */
export const CAP_MANAGE_ACCOUNTS = 'canManageAccounts';

/** 进入管理后台所需能力 */
export const ADMIN_REQUIRED_CAPS: Capability[] = [CAP_MANAGE_CONTENT];

/** 进入社团成员产出页所需能力 */
export const PRODUCTIONS_REQUIRED_CAPS: Capability[] = [CAP_VIEW_RESTRICTED];

/**
 * 申请权限的对外联系邮箱。
 * 单一出处：登录页与路由守卫共用，避免两处文案漂移。
 */
export const ACCESS_REQUEST_EMAIL = '1458164460@qq.com';

/** 「社团成员产出」的准入提示，登录页与守卫页共用同一份文案 */
export const PRODUCTIONS_ACCESS_NOTICE =
  `社团成员产出仅限有权限账号进行浏览，可发送邮箱至${ACCESS_REQUEST_EMAIL}申请权限`;

/** 判断是否满足全部所需能力 */
export function satisfies(capabilities: Capability[], required: Capability[]): boolean {
  return required.every((c) => capabilities.includes(c));
}

/** 角色展示名 */
export function roleLabel(role: Role | 'guest'): string {
  if (role === 'admin') return '管理权限';
  if (role === 'viewer') return '临时浏览权限';
  return '访客';
}
