// DSH's bundle loader resolves the host half at <package>/index.js,
// so keep this tiny re-export shim at the package root.
export * from './src/host/index.js'
