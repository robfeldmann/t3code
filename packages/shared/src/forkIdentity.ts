export const ForkIdentity = {
  appId: "com.pajamasoft.t3code",
  productName: "T3 Code (PJS)",
  scheme: "t3code-pjs",
  userDataDirName: "t3code-pjs",
  dataRootDirName: "t3code-pjs",
  // Electron names the Keychain safeStorage item from this before the app runs; it must differ from the official app's.
  packageName: "t3code-pjs",
} as const;
