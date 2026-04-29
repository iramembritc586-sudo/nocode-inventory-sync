import { createClient } from '@meituan-nocode/backend-sdk';

// 创建客户端实例
export const nocodeBackend = createClient({
  appId: "vl32ek1wlruci2zv",
  serverUrl: "https://proxy-dbvl32ek1wlruci2zv.database.nocode.cn/database/api/public",
  authEnabled:true,
});

export const authWeb = nocodeBackend.authWeb;
