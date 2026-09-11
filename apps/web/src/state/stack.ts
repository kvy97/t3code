import { createStackEnvironmentAtoms } from "@t3tools/client-runtime/state/stack";

import { connectionAtomRuntime } from "../connection/runtime";

export const stackEnvironment = createStackEnvironmentAtoms(connectionAtomRuntime);
