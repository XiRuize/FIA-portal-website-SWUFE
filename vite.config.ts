import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import appdevDesignMode from '@xagi/vite-plugin-design-mode';

/**
 * 修 `@xagi/vite-plugin-design-mode` 的 **Windows 路径转义缺陷**。
 *
 * ## 现象（很容易被误判成应用缺陷）
 *
 * 开发态页面**每隔约 0.7 秒整页重载一次**，表现为：
 * scroll-reveal 版块反复回到 opacity:0、滚动驱动动画（`ScrollManifesto`）在某个
 * 进度档位上「整屏空白」、`window` 上的临时标记（调试用）莫名丢失、
 * 控制台刷出成百上千条 `/@appdev-design-mode/client.js 500`。
 * 用 CDP 订阅 `Page.frameNavigated` 可以看到重载确实发生，而不是渲染出错。
 *
 * ## 根因
 *
 * 插件在 `load` 里把客户端入口的相对导入改写成绝对路径，但**没有转义反斜杠**：
 *
 * ```js
 * const absolutePath = resolve(clientDir, moduleName);   // C:\Users\...\DesignModeContext
 * return `from '${absolutePath}'`;                       // 反斜杠进了 JS 字符串字面量
 * ```
 *
 * 这段字符串随后被 Vite 当源码解析，`\U` `\D` `\n` 等被当作转义序列吞掉，
 * 得到 `C:Users...node_modules...reactdistDesignModeContext` —— 找不到文件，
 * 于是虚拟模块解析失败并触发重载。**Linux/macOS 上路径本就没有反斜杠，所以只坑 Windows。**
 *
 * ## 修法
 *
 * 包一层 `load`，把该虚拟模块产物里的 Windows 绝对路径统一换成正斜杠
 * （Vite 在 Windows 上认正斜杠）。放在**项目内**而不是改 `node_modules`，
 * 重装依赖后依然生效。
 */
function fixWindowsPathInDesignMode(plugin: any) {
  const originalLoad = plugin.load;
  if (typeof originalLoad !== 'function') return plugin;

  const escapeWindowsPath = (code: string) =>
    code.replace(/(from\s+['"])([A-Za-z]:[^'"]*)(['"])/g, (_m, head, p, tail) =>
      head + p.replace(/\\/g, '/') + tail
    );

  return {
    ...plugin,
    load(this: unknown, id: string, options?: any) {
      const result = originalLoad.call(this, id, options);
      const patch = (r: any) =>
        typeof r === 'string'
          ? escapeWindowsPath(r)
          : r && typeof r.code === 'string'
            ? { ...r, code: escapeWindowsPath(r.code) }
            : r;

      if (id && id.includes('virtual:appdev-design-mode-client')) {
        return result && typeof result.then === 'function' ? result.then(patch) : patch(result);
      }
      return result;
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    
  // <!-- DEV-INJECT-START -->
  {
    name: 'dev-inject',
    enforce: 'post', // 确保在 HTML 注入阶段最后执行
    transformIndexHtml(html) {
      if (!html.includes('data-id="dev-inject-monitor"')) {
        return html.replace("</head>", `
    <script data-id="dev-inject-monitor">
      (function() {
        const remote = "/sdk/dev-monitor.js";
        const separator = remote.includes('?') ? '&' : '?';
        const script = document.createElement('script');
        script.src = remote + separator + 't=' + Date.now();
        script.dataset.id = 'dev-inject-monitor-script';
        script.defer = true;
        // 防止重复注入
        if (!document.querySelector('[data-id="dev-inject-monitor-script"]')) {
          document.head.appendChild(script);
        }
      })();
    </script>
  \n</head>`);
      }
      return html;
    }
  },
  // <!-- DEV-INJECT-END -->
  
    react(),
      fixWindowsPathInDesignMode(appdevDesignMode())
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    // ⚠️ 显式绑定 127.0.0.1。
    // Vite 默认只监听 IPv6 的 `[::1]`，于是 `http://127.0.0.1:5173` 直接连不上
    // （curl 返回空、浏览器报「无法访问」），只有 `http://localhost:5173` 能开。
    // 本机开发时用 IP 直连更省事，故写死 IPv4 回环地址。
    // 只绑回环、不绑 0.0.0.0 —— 避免把开发服务器暴露到局域网。
    host: '127.0.0.1',
    // 把 /api 反向代理到自建后端。
    // 这样浏览器看到的是**同源请求**，有两个实际好处：
    // 1) 会话 Cookie 能正常携带（跨端口会被判定为跨站，SameSite=Lax 不放行）；
    // 2) 生产环境用 HTTPS 时不会踩到「HTTPS 页面请求 HTTP 后端」的混合内容拦截。
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
  /**
   * `vite preview` 用生产产物起服务，**不加载任何插件**（设计模式插件在 build 时本就禁用），
   * 因此是一条不会踩到开发态插件问题的干净通道。
   * 但 `preview` 有独立的 proxy 配置 —— 不在这里再写一遍，/api 会 404，
   * 表现就是「构建产物上 logo 墙与新闻全是空的」。故与 server.proxy 保持一致。
   */
  preview: {
    port: 4173,
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
});
