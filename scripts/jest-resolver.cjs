// Plist exposes only an ESM import entry. Production uses native import();
// Jest transforms that entry for its CommonJS test environment.
module.exports = (request, options) => options.defaultResolver(
  request,
  request === 'plist'
    ? { ...options, conditions: [...(options.conditions || []), 'import'] }
    : options,
);
