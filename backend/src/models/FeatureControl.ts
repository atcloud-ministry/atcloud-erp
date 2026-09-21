import mongoose, { Schema } from "mongoose";
import {
  ALUMNI_NETWORK_MODES,
  type AlumniNetworkMode,
} from "../config/alumniNetworkFeature";

export const FEATURE_CONTROL_SINGLETON_ID = "alumni_network" as const;
export const FEATURE_CONTROL_COLLECTION = "feature_controls" as const;

export interface IFeatureControl {
  _id: typeof FEATURE_CONTROL_SINGLETON_ID;
  mode: AlumniNetworkMode;
  revision: number;
  changedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const featureControlSchema = new Schema<IFeatureControl>(
  {
    _id: {
      type: String,
      required: true,
      immutable: true,
      validate: {
        validator: (value: string) => value === FEATURE_CONTROL_SINGLETON_ID,
        message: "FeatureControl uses a fixed singleton id.",
      },
    },
    mode: {
      type: String,
      enum: ALUMNI_NETWORK_MODES,
      required: true,
    },
    revision: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: "FeatureControl revision must be a safe integer.",
      },
    },
    changedBy: {
      type: String,
      required: true,
      match: /^[a-fA-F0-9]{24}$/,
    },
  },
  {
    collection: FEATURE_CONTROL_COLLECTION,
    timestamps: true,
    versionKey: false,
    strict: "throw",
  },
);

const FeatureControl =
  (mongoose.models.FeatureControl as
    | mongoose.Model<IFeatureControl>
    | undefined) ||
  mongoose.model<IFeatureControl>("FeatureControl", featureControlSchema);

export default FeatureControl;
