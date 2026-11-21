/**
 * @file main.ts
 * @description 前端管控工作台 TypeScript 模块化入口。
 */

import { WorkbenchApiClient } from './WorkbenchApiClient.ts';
import { WorkbenchViewController } from './WorkbenchViewController.ts';

window.addEventListener('DOMContentLoaded', () => {
  const apiClient = new WorkbenchApiClient();
  const controller = new WorkbenchViewController(apiClient);
  void controller.initialize();
});
