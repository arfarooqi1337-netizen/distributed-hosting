/**
 * Tunnel Service
 *
 * Manages network tunnels between the controller/VPS and community nodes.
 * Provides a unified interface for routing traffic to nodes regardless of
 * their network topology.
 *
 * Supported tunnel types:
 *   - wireguard: WireGuard mesh VPN (best for production)
 *   - tailscale: Tailscale zero-config VPN (easiest setup)
 *   - direct: Node has public IP / port forwarding
 *   - zerotier: ZeroTier mesh VPN
 *
 * The tunnel service doesn't establish tunnels itself — that's handled
 * by the external VPN software. Instead, it tracks each node's tunnel
 * endpoint so the reverse proxy knows where to route traffic.
 *
 * For local development, all nodes are "direct" on localhost.
 */

const Node = require('../models/Node');
const logger = require('../config/logger');

/**
 * Update a node's tunnel endpoint information.
 * Called when a node reports its tunnel address, or when
 * the admin manually configures it.
 */
async function updateNodeTunnel(nodeId, tunnelEndpoint, tunnelType) {
  const validTypes = ['', 'wireguard', 'tailscale', 'direct', 'zerotier'];
  const type = validTypes.includes(tunnelType) ? tunnelType : '';

  await Node.updateOne(
    { nodeId },
    {
      $set: {
        tunnelEndpoint,
        tunnelType: type,
      },
    }
  );

  logger.info(`Node ${nodeId} tunnel updated: ${type} → ${tunnelEndpoint}`);
}

/**
 * Get the reachable address for a node's service port.
 * Returns the address that the reverse proxy should use to reach
 * a specific service port on this node.
 *
 * Examples:
 *   - direct:203.0.113.5 → 203.0.113.5:8081
 *   - wg:10.0.0.2        → 10.0.0.2:8081
 *   - ts:100.64.0.1      → 100.64.0.1:8081
 *   - local node          → localhost:8081
 */
async function getNodeAddress(nodeId, port) {
  const node = await Node.findOne({ nodeId }).lean();
  if (!node) return null;

  // If no tunnel, use the node's IP or localhost
  if (!node.tunnelEndpoint) {
    return `localhost:${port}`;
  }

  const endpoint = node.tunnelEndpoint;
  return `${endpoint}:${port}`;
}

/**
 * Get all nodes with their tunnel info for the admin panel.
 */
async function getTunnelStatus() {
  const nodes = await Node.find({})
    .select('nodeId name tunnelEndpoint tunnelType status')
    .lean();

  return nodes.map((n) => ({
    nodeId: n.nodeId,
    name: n.name,
    status: n.status,
    tunnelEndpoint: n.tunnelEndpoint || 'Not configured',
    tunnelType: n.tunnelType || 'direct (localhost)',
  }));
}

/**
 * Generate a WireGuard configuration snippet for a peer.
 * Used when auto-configuring WireGuard on the VPS.
 */
function generateWireGuardPeerConfig(nodeId, publicKey, allowedIPs) {
  return `[Peer]
# Node: ${nodeId}
PublicKey = ${publicKey}
AllowedIPs = ${allowedIPs}
PersistentKeepalive = 25
`;
}

/**
 * Get connection instructions for different tunnel types.
 */
function getTunnelSetupInstructions(tunnelType) {
  const instructions = {
    wireguard: `
  WireGuard Setup (VPS + Node):
    1. Install WireGuard on the VPS:
       sudo apt install wireguard
    2. Generate keys on each node:
       wg genkey | tee privatekey | wg pubkey > publickey
    3. Add peer config to VPS's /etc/wireguard/wg0.conf
    4. Start WireGuard: sudo wg-quick up wg0
    5. Nodes will have IPs in the 10.0.0.0/24 range
`,
    tailscale: `
  Tailscale Setup (VPS + Node):
    1. Install Tailscale on VPS and all nodes:
       curl -fsSL https://tailscale.com/install.sh | sh
    2. Start Tailscale: sudo tailscale up
    3. All devices get a 100.x.x.x IP automatically
    4. Nodes are reachable by their Tailscale IP
`,
    zerotier: `
  ZeroTier Setup (VPS + Node):
    1. Install ZeroTier on VPS and all nodes
    2. Join the same network: sudo zerotier-cli join <network-id>
    3. Authorize members in the ZeroTier admin panel
    4. Nodes get managed IPs in the network
`,
    direct: `
  Direct Connection:
    Node must have a public IP or port forwarding configured.
    Not recommended for residential connections.
`,
  };

  return instructions[tunnelType] || instructions.direct;
}

module.exports = {
  updateNodeTunnel,
  getNodeAddress,
  getTunnelStatus,
  generateWireGuardPeerConfig,
  getTunnelSetupInstructions,
};
