'use strict';

module.exports = {
  dependency: {
    platforms: {
      android: {
        // Keep this relative. Both the Community CLI and Expo autolinking
        // resolve sourceDir from the installed package root.
        sourceDir: 'android',
        packageImportPath: 'import com.bundledrop.BundleDropPackage;',
        packageInstance: 'new BundleDropPackage()',
      },
    },
  },
};
