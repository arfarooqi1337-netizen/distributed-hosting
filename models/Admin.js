/**
 * Admin model
 *
 * Manages admin panel users with role-based access.
 * Enforces strong password policy and secure password hashing.
 */

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

/**
 * Validate password strength.
 * Minimum 12 chars, at least 1 uppercase, 1 lowercase, 1 digit, 1 special char.
 */
function isValidPassword(password) {
  if (!password || password.length < 12) return false;
  if (!/[A-Z]/.test(password)) return false;
  if (!/[a-z]/.test(password)) return false;
  if (!/[0-9]/.test(password)) return false;
  if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(password)) return false;
  return true;
}

const adminSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: true,
    },
    role: {
      type: String,
      enum: ['admin', 'superadmin'],
      default: 'admin',
    },
    name: {
      type: String,
      default: 'Admin',
    },
    lastLogin: { type: Date },
    isActive: {
      type: Boolean,
      default: true,
    },
    mustChangePassword: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.password;
        delete ret.__v;
        return ret;
      },
    },
  }
);

// Validate password strength before saving
adminSchema.pre('validate', function (next) {
  if (this.isModified('password') && !isValidPassword(this.password)) {
    this.invalidate(
      'password',
      'Password must be at least 12 characters with uppercase, lowercase, digit, and special character'
    );
  }
  next();
});

// Hash password before saving
adminSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  try {
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Static method for password validation
adminSchema.statics.validatePasswordStrength = isValidPassword;

const Admin = mongoose.model('Admin', adminSchema);

module.exports = Admin;
