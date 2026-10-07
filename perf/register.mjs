import { registerHooks } from 'node:module'
import { load } from './patch-hooks.mjs'

// 同步补丁留在当前线程，省去异步 loader 的线程与每个模块的消息往返。
registerHooks({ load })
