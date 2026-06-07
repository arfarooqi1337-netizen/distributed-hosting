/**
 * Client model
 *
 * Represents a customer/client who uses the hosting platform.
 * Each client can own multiple projects and domains.
 * Prepared for future billing, plans, and user portal integration.
 *
 * NOTE: Client-facing portal is Phase 2. This model establishes
 * the data foundation so all existing systems reference a client.
 */

const mongoose = require('mongoose');

const clientSchema = new mongoose.Schema(
  {
    clientId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      enum: ['active', 'suspended', 'disabled'],
      default: 'active',
    },
    // Contact info
    company: { type: String, default: '' },
    phone: { type: String, default: '' },
    address: { type: String, default: '' },
    // Authentication
    password: { type: String },
    authType: {
      type: String,
      enum: ['password', 'oauth', 'magic_link', 'invite_only'],
      default: 'invite_only',
    },
    // Plan & billing (Phase 2)
    plan: {
      type: String,
      enum: ['free', 'starter', 'pro', 'enterprise', 'custom'],
      default: 'free',
    },
    billing: {
      provider: { type: String, enum: ['stripe', 'crypto', 'manual', ''], default: '' },
      customerId: { type: String, default: '' },
      subscriptionId: { type: String, default: '' },
      nextBillingDate: { type: Date },
      monthlySpend: { type: Number, default: 0 },
      currency: { type: String, default: 'usd' },
    },
    // Limits
    limits: {
      maxWebsites: { type: Number, default: 1 },
      maxBandwidthMb: { type: Number, default: 1024 },
      maxStorageMb: { type: Number, default: 512 },
      maxNodes: { type: Number, default: 1 },
    },
    // Usage (updated periodically)
    usage: {
      totalWebsites: { type: Number, default: 0 },
      totalBandwidthMb: { type: Number, default: 0 },
      totalStorageMb: { type: Number, default: 0 },
      totalDeployments: { type: Number, default: 0 },
    },
    // Security
    apiKey: { type: String, default: '' },
    lastLoginAt: { type: Date },
    lastLoginIp: { type: String, default: '' },
    // Metadata
    notes: { type: String, default: '' },
    tags: [{ type: String }],
    invitedBy: { type: String, default: '' },
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.password;
        delete ret.apiKey;
        delete ret.__v;
        return ret;
      },
    },
  }
);

clientSchema.index({ email: 1 });
clientSchema.index({ status: 1 });

const Client = mongoose.model('Client', clientSchema);

module.exports = Client;
