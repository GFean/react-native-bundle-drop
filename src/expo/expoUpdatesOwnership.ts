type ExpoUpdatesState = 'absent' | 'disabled' | 'active';

export type ExpoUpdatesOwnership = {
  state: ExpoUpdatesState;
  packageIsInstalled: boolean;
  packageIsDeclared: boolean;
  pluginIsDeclared: boolean;
  hasUpdatesUrl: boolean;
  explicitlyEnabled: boolean;
  explicitlyDisabled: boolean;
};

type ExpoUpdatesOwnershipModule = {
  EXPO_UPDATES_DISABLED_WARNING: string;
  getExpoUpdatesOwnership: (
    config: Record<string, any>,
    options: { projectRoot: string; packageIsInstalled?: boolean },
  ) => ExpoUpdatesOwnership;
};

// The config plugin and the TypeScript CLI deliberately share this pure module.
// Keeping ownership classification here prevents setup, doctor, export, and the
// generated native integration from disagreeing about who controls startup.
const expoUpdatesOwnership = require('../../plugin/expoUpdates') as ExpoUpdatesOwnershipModule;

export function inspectExpoUpdatesOwnership(
  projectRoot: string,
  evaluatedExpoConfig: Record<string, any>,
): ExpoUpdatesOwnership {
  return expoUpdatesOwnership.getExpoUpdatesOwnership(evaluatedExpoConfig, { projectRoot });
}

export function assertExpoUpdatesDoesNotOwnStartup(
  projectRoot: string,
  evaluatedExpoConfig: Record<string, any>,
): ExpoUpdatesOwnership {
  const ownership = inspectExpoUpdatesOwnership(projectRoot, evaluatedExpoConfig);
  if (ownership.state === 'active') {
    throw new Error(
      'Active expo-updates blocks Bundle Drop because it can own native startup. ' +
        'Run `bundle-drop init --migrate-expo-updates` and create a new native binary.',
    );
  }
  if (ownership.state === 'disabled') {
    console.warn(expoUpdatesOwnership.EXPO_UPDATES_DISABLED_WARNING);
  }
  return ownership;
}
