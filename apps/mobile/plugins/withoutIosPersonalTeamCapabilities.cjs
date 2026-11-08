const { withEntitlementsPlist } = require("expo/config-plugins");

module.exports = function withoutIosPersonalTeamCapabilities(
  config,
  { keepAppGroups = false } = {},
) {
  return withEntitlementsPlist(config, (modConfig) => {
    delete modConfig.modResults["aps-environment"];
    delete modConfig.modResults["com.apple.developer.applesignin"];
    if (!keepAppGroups) delete modConfig.modResults["com.apple.security.application-groups"];
    return modConfig;
  });
};
