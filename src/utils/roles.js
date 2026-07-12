const ALL_STAFF_ROLES = ['super_admin', 'admin', 'loan_officer', 'credit_manager'];
const MANAGEABLE_ROLES = ALL_STAFF_ROLES; // roles Super Admin can assign

function parseRoles(rolesStr) {
  return (rolesStr || '').split(',').map(r => r.trim()).filter(Boolean);
}

function rolesToString(rolesArr) {
  return Array.from(new Set(rolesArr)).join(',');
}

function hasAnyRole(userRolesStr, allowedRoles) {
  const userRoles = parseRoles(userRolesStr);
  return allowedRoles.some(r => userRoles.includes(r));
}

function isStaffAccount(rolesStr) {
  return hasAnyRole(rolesStr, ALL_STAFF_ROLES);
}

module.exports = { ALL_STAFF_ROLES, MANAGEABLE_ROLES, parseRoles, rolesToString, hasAnyRole, isStaffAccount };
