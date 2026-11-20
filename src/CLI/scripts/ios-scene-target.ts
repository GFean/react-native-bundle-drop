import fs from 'fs';
import path from 'path';

import { inspectProjectFile } from './safe-file-transaction';

const dict = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    ? value as Record<string, unknown>
    : {};

const isIdList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0);

const ids = (value: unknown): string[] => isIdList(value) ? value : [];

const xcodeRelativePath = (value: unknown): string | null =>
  typeof value === 'string' &&
  value.length > 0 &&
  !/[$\\\\]/.test(value) &&
  !path.posix.isAbsolute(value) &&
  !value.split('/').some(part => !part || part === '.' || part === '..')
    ? value
    : null;

const requireOne = <T>(items: T[], reason: string): T => {
  if (items.length !== 1) throw new Error(reason);
  return items[0];
};

const readXcodeProject = (value: unknown) => {
  const project = dict(value);
  const objects = dict(project.objects);
  const get = (id: unknown) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(objects, id)
    ? dict(objects[id])
    : {};
  const root = get(project.rootObject);
  if (root.isa !== 'PBXProject' || root.projectDirPath || root.projectRoot) {
    throw new Error('The Xcode project must resolve iOS source paths from the project directory.');
  }
  const targets = ids(root.targets).map(get);
  const applications = targets.filter(target =>
    target.isa === 'PBXNativeTarget' && target.productType === 'com.apple.product-type.application',
  );
  return { objects, get, root, targets, applications };
};

const excludesSceneDelegate = (project: ReturnType<typeof readXcodeProject>) => {
  const { get, objects, root, targets } = project;
  const referencesOtherProjects = root.projectReferences !== undefined &&
    (!Array.isArray(root.projectReferences) || root.projectReferences.length > 0);
  const hasSynchronizedSources = Object.values(objects).some(item =>
    dict(item).isa === 'PBXFileSystemSynchronizedRootGroup',
  );
  if (!isIdList(root.targets) || referencesOtherProjects || hasSynchronizedSources) return false;

  return targets.every(target => {
    const nativeTarget = target.isa === 'PBXNativeTarget' && typeof target.productType === 'string';
    const usesCustomBuildRules = target.buildRules !== undefined &&
      (!isIdList(target.buildRules) || target.buildRules.length > 0);
    if ((!nativeTarget && target.isa !== 'PBXAggregateTarget') ||
        target.fileSystemSynchronizedGroups !== undefined || usesCustomBuildRules ||
        !isIdList(target.buildPhases)) return false;

    return target.buildPhases.map(get).every(phase => {
      if (phase.isa === 'PBXSourcesBuildPhase') {
        return isIdList(phase.files) && phase.files.map(get).every(buildFile => {
          const source = get(buildFile.fileRef);
          const sourcePath = xcodeRelativePath(source.path);
          return buildFile.isa === 'PBXBuildFile' && source.isa === 'PBXFileReference' &&
            sourcePath !== null && !/(?:^|\/)SceneDelegate\.swift$/i.test(sourcePath);
        });
      }
      return typeof phase.isa === 'string';
    });
  });
};

const hasLiteralSceneSettings = (config: Record<string, unknown>) =>
  config.isa === 'XCBuildConfiguration' && !Object.keys(config).some(key => key.startsWith('baseConfigurationReference')) &&
  !Object.entries(dict(config.buildSettings))
    .some(([key, value]) => key.startsWith('INFOPLIST_KEY_UIApplicationSceneManifest') ||
      key.startsWith('INFOPLIST_FILE[') ||
      (/^(?:INFOPLIST_PREPROCESS|GENERATE_INFOPLIST_FILE)(?:\[|$)/.test(key) && value !== 'NO'));

/** Resolve the literal source paths that the app target actually compiles. */
const targetSourcePaths = (
  objects: Record<string, unknown>,
  rootGroup: string,
  sourceFileIds: Set<string>,
  projectDirectory: string,
) => {
  const results: string[] = [];
  const visited = new Set<string>();
  const pending = [{ id: rootGroup, directory: projectDirectory }];

  while (pending.length) {
    const { id, directory } = pending.pop()!;
    if (visited.has(id)) throw new Error('iOS project references a source group more than once.');
    visited.add(id);
    const item = dict(objects[id]);
    const group = item.isa === 'PBXGroup';
    if (!group && (item.isa !== 'PBXFileReference' || !sourceFileIds.has(id))) continue;
    const base = item.sourceTree === 'SOURCE_ROOT' ? projectDirectory
      : item.sourceTree === '<group>' ? directory : null;
    const name = item.path === undefined && group ? '' : xcodeRelativePath(item.path);
    if (base === null || name === null) continue;
    const relativePath = path.posix.join(base, name);
    if (group) {
      for (const childId of ids(item.children)) pending.push({ id: childId, directory: relativePath });
    } else {
      results.push(relativePath);
    }
  }
  return results;
};

const targetSourceFileIds = (target: Record<string, unknown>, get: ReturnType<typeof readXcodeProject>['get']) => {
  const sourcePhases = ids(target.buildPhases).map(get).filter(item => item.isa === 'PBXSourcesBuildPhase');
  return new Set(sourcePhases.flatMap(phase =>
    ids(phase.files).map(get).flatMap(item =>
      item.isa === 'PBXBuildFile' && typeof item.fileRef === 'string' ? [item.fileRef] : []),
  ));
};

/** Project only Xcode app target membership and literal Info.plist paths. */
export function readXcodeApplicationTargets(value: unknown, projectDirectory: string) {
  const { objects, get, root, applications } = readXcodeProject(value);
  return applications.slice(0, 8).map(target => {
    const sourcePaths = targetSourcePaths(
      objects, String(root.mainGroup), targetSourceFileIds(target, get), projectDirectory,
    );
    const infoPlistPaths = ids(get(target.buildConfigurationList).buildConfigurations).map(get).flatMap(config => {
      const setting = dict(config.buildSettings).INFOPLIST_FILE;
      const infoPlistPath = xcodeRelativePath(typeof setting === 'string'
        ? setting.replace(/^\$(?:\((?:SRCROOT|PROJECT_DIR)\)|\{(?:SRCROOT|PROJECT_DIR)\})\//, '')
        : setting);
      return infoPlistPath?.endsWith('.plist') ? [path.posix.join(projectDirectory, infoPlistPath)] : [];
    });
    return { sourcePaths, infoPlistPaths };
  });
}

export async function readIosSceneTarget(projectRoot: string): Promise<{
  appDelegate: string;
  sceneDelegate: string;
} | null> {
  const projectNames = fs.readdirSync(path.join(projectRoot, 'ios')).filter(file => file.endsWith('.xcodeproj'));
  if (!projectNames.length) throw new Error('An Xcode project is required to identify the iOS scene delegate.');
  const { parse, parseOpenStep } = await import('plist');
  const read = (file: string) => {
    const source = inspectProjectFile(projectRoot, file);
    if (!source.exists) throw new Error(`iOS target metadata is missing: ${file}`);
    return source.content;
  };
  const configurationList = (value: unknown, get: ReturnType<typeof readXcodeProject>['get']) =>
    ids(get(value).buildConfigurations).map(get);
  const readTargetPlist = (configs: Record<string, unknown>[]) => {
    const buildSettings = configs.map(config => dict(config.buildSettings));
    if (buildSettings.some(settings => settings.INFOPLIST_PREPROCESS === 'YES' ||
        Object.keys(settings).some(key => key.startsWith('INFOPLIST_KEY_UIApplicationSceneManifest')))) {
      throw new Error('The Xcode app uses a computed iOS scene manifest.');
    }
    const infoPlistPath = requireOne(
      [...new Set(buildSettings.map(settings => xcodeRelativePath(settings.INFOPLIST_FILE)))],
      'iOS app build configurations must identify the same Info.plist.',
    );
    if (!infoPlistPath?.endsWith('.plist')) throw new Error('The iOS app has no literal Info.plist path.');
    const plistSource = read(`ios/${infoPlistPath}`).replace(/^\uFEFF/, '');
    if (!plistSource.trimStart().startsWith('<')) throw new Error('iOS Info.plist must be XML.');
    const plist = dict(parse(plistSource));
    if (!Object.keys(plist).length) throw new Error('iOS Info.plist must contain a dictionary.');
    return plist;
  };

  const projects = projectNames.map(name => readXcodeProject(parseOpenStep(read(`ios/${name}/project.pbxproj`))));
  if (projects.length > 1 || projects[0].applications.length !== 1) {
    // A legacy fallback here requires positive evidence from every project's declared sources and app configuration.
    const hasApplication = projects.some(project => project.applications.length > 0);
    const dormantScene = hasApplication && projects.every(project => {
      if (!excludesSceneDelegate(project)) return false;
      const { get, root, applications } = project;
      const projectConfigs = configurationList(root.buildConfigurationList, get);
      if (root.buildConfigurationList !== undefined && !projectConfigs.length) return false;
      return projectConfigs.every(hasLiteralSceneSettings) && applications.every(target => {
        const configs = configurationList(target.buildConfigurationList, get);
        return configs.length > 0 && configs.every(hasLiteralSceneSettings) &&
          readTargetPlist(configs).UIApplicationSceneManifest === undefined;
      });
    });
    if (dormantScene) return null;
    throw new Error('Could not prove SceneDelegate is dormant in this multi-target or multi-project iOS app.');
  }

  const { objects, get, root, applications: [target] } = projects[0];
  const plist = readTargetPlist(configurationList(target.buildConfigurationList, get));
  if (plist.UIApplicationSceneManifest === undefined) return null;
  const manifest = dict(plist.UIApplicationSceneManifest);
  const roles = dict(manifest.UISceneConfigurations);
  const configurations = roles.UIWindowSceneSessionRoleApplication;
  if (
    manifest.UIApplicationSupportsMultipleScenes === true ||
    Object.keys(roles).length !== 1 ||
    !Array.isArray(configurations) ||
    configurations.length !== 1 ||
    dict(configurations[0]).UISceneDelegateClassName !== '$(PRODUCT_MODULE_NAME).SceneDelegate'
  ) {
    throw new Error('The application scene configuration does not uniquely register SceneDelegate.');
  }

  const delegates = targetSourcePaths(objects, String(root.mainGroup), targetSourceFileIds(target, get), 'ios');
  return {
    appDelegate: requireOne(delegates.filter(file => file.endsWith('/AppDelegate.swift')),
      'The iOS app target must compile exactly one AppDelegate.swift.'),
    sceneDelegate: requireOne(delegates.filter(file => file.endsWith('/SceneDelegate.swift')),
      'The iOS app target must compile exactly one SceneDelegate.swift.'),
  };
}
