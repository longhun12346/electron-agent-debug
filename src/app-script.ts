// How code that this server evaluates in the main process gets Electron's module. The inspector's global scope has no
// `require`, and a dynamic `import()` does not work in an evaluation ("A dynamic import callback was not specified").
// `process.mainModule` was there in both a CommonJS and an ES module main process (measured on Electron 45); without it
// a `require` built from the executable's path returns the same module (also measured, in both).
export const requireElectron = "(process.mainModule ? process.mainModule.require('electron')" +
  " : process.getBuiltinModule('node:module').createRequire(process.execPath)('electron'))";
