export type DatabaseModuleStatus = {
  connected: boolean;
};

export function getDatabaseModuleStatus(): DatabaseModuleStatus {
  return { connected: false };
}
