import { Config } from './config.js';
import { CompanionCoreService } from './core/service.js';
import * as exportModule from './modules/export/index.js';
import * as handoffModule from './modules/handoff/index.js';
import * as costModule from './modules/cost/index.js';
import * as searchModule from './modules/search/index.js';
import * as traceModule from './modules/trace/index.js';
import * as promptModule from './modules/prompt/index.js';
import * as arenaModule from './modules/arena/index.js';
import * as orchestratorModule from './modules/orchestrator/index.js';
import * as teamModule from './modules/team/index.js';
import * as securityModule from './modules/security/index.js';
export const name = 'deepseek-companion';
export { Config };
export function apply(ctx, config) {
    ctx.plugin(CompanionCoreService, config);
    if (config.enableExport) {
        ctx.plugin(exportModule);
    }
    if (config.enableHandoff) {
        ctx.plugin(handoffModule);
    }
    if (config.enableCost) {
        ctx.plugin(costModule);
    }
    if (config.enableSearch) {
        ctx.plugin(searchModule);
    }
    if (config.enableTrace) {
        ctx.plugin(traceModule);
    }
    if (config.enablePrompt) {
        ctx.plugin(promptModule);
    }
    if (config.enableArena) {
        ctx.plugin(arenaModule);
    }
    if (config.enableOrchestrator) {
        ctx.plugin(orchestratorModule);
    }
    if (config.enableTeam) {
        ctx.plugin(teamModule);
    }
    if (config.enableSecurity) {
        ctx.plugin(securityModule);
    }
}
