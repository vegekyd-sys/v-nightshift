import { runHttpScenario as recoveryScenario } from "./bounded-recovery-http-scenario.mjs";
export const runHttpScenario = options => recoveryScenario({ ...options, id: "NS-TIME-1029", timeRecovery: true });
