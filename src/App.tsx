import { RouterProvider } from 'react-router-dom';
import { router } from '@/router';
import { ContentProvider } from '@/lib/store';
import { AuthProvider } from '@/lib/auth';

/**
 * 根组件：注入站点内容仓库与会话状态，并提供 hash 路由上下文。
 *
 * Provider 嵌套顺序：AuthProvider 在外。原因是内容仓库在渲染时可能需要
 * 依据登录态决定「是否请求受限内容」，而它只能用内层 hook 读取外层 context。
 */
function App() {
  return (
    <AuthProvider>
      <ContentProvider>
        <RouterProvider router={router} />
      </ContentProvider>
    </AuthProvider>
  );
}

export default App;
