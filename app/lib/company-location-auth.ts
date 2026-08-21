import { getAdminClient } from "./shopify-client-credentials";

/**
 * The name of Shopify's built-in B2B role that grants a company contact
 * administrative control over a location. Shopify exposes exactly two roles,
 * "Location admin" and "Ordering only"; only the former may edit tax data.
 *
 * Matched case-insensitively because the role is a shop-level record whose GID
 * differs per shop, leaving the name as the only stable identifier.
 */
export const LOCATION_ADMIN_ROLE_NAME = "location admin";

/** Page size for walking a location's role assignments. */
const ROLE_ASSIGNMENT_PAGE_SIZE = 250;

type AdminClient = Awaited<ReturnType<typeof getAdminClient>>;

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; field?: string[] }>;
}

interface RoleAssignmentEdge {
  node: {
    role: { name: string } | null;
    companyContact: { customer: { id: string } | null } | null;
  };
}

interface RoleAssignmentsResponse {
  companyLocation: {
    id: string;
    roleAssignments: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      edges: RoleAssignmentEdge[];
    };
  } | null;
}

const ROLE_ASSIGNMENTS_QUERY = `query CompanyLocationRoleAssignments($id: ID!, $first: Int!, $after: String) {
  companyLocation(id: $id) {
    id
    roleAssignments(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          role {
            name
          }
          companyContact {
            customer {
              id
            }
          }
        }
      }
    }
  }
}`;

/**
 * Whether a GID refers to a company location. Guards against a caller passing
 * an arbitrary owner GID (a product, another customer, ...) to a route that
 * only ever intends to act on a location.
 */
export function isCompanyLocationGid(gid: unknown): gid is string {
  return typeof gid === "string" && gid.startsWith("gid://shopify/CompanyLocation/");
}

export interface LocationAdminCheck {
  authorized: boolean;
  /** Reason to surface to the caller when `authorized` is false. */
  reason?: string;
}

/**
 * Confirm that `customerId` is a company contact holding the "Location admin"
 * role on `companyLocationId`.
 *
 * This deliberately re-derives the relationship from the Admin API rather than
 * trusting anything the extension sent. The extension performs the same check
 * client-side, but only to decide whether to render an edit affordance -- a
 * caller can post whatever location ID they like, so this is the real gate.
 */
export async function verifyLocationAdmin(
  admin: AdminClient,
  customerId: string,
  companyLocationId: string
): Promise<LocationAdminCheck> {
  let after: string | null = null;

  // Walk every page: a large company can have more contacts on one location
  // than a single page holds, and stopping early would deny a legitimate admin.
  for (;;) {
    const response: GraphQLResponse<RoleAssignmentsResponse> =
      await admin.graphql<RoleAssignmentsResponse>(ROLE_ASSIGNMENTS_QUERY, {
        id: companyLocationId,
        first: ROLE_ASSIGNMENT_PAGE_SIZE,
        after,
      });

    if (response.errors?.length) {
      console.error("Role assignment lookup failed:", response.errors);
      return { authorized: false, reason: "Could not verify location access" };
    }

    const location = response.data?.companyLocation;
    if (!location) {
      return { authorized: false, reason: "Company location not found" };
    }

    const assignments = location.roleAssignments;
    const match = assignments.edges.some(({ node }: RoleAssignmentEdge) => {
      const isSameCustomer = node.companyContact?.customer?.id === customerId;
      const isAdminRole =
        node.role?.name?.trim().toLowerCase() === LOCATION_ADMIN_ROLE_NAME;
      return isSameCustomer && isAdminRole;
    });

    if (match) {
      return { authorized: true };
    }

    if (!assignments.pageInfo.hasNextPage || !assignments.pageInfo.endCursor) {
      return {
        authorized: false,
        reason: "You are not an admin for this company location",
      };
    }

    after = assignments.pageInfo.endCursor;
  }
}
