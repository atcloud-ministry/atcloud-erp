import type { RegistrationProfileInput } from "@atcloud/shared-time/registration-profile";
import {
  buildRegistrationProfileKpis,
  type RegistrationProfileKpisDTO,
  type RegistrationProfileKpiSource,
} from "../contracts/registrationProfileKpiContracts";
import { User } from "../models";

type RegistrationProfileKpiRow = RegistrationProfileInput & {
  isActive: boolean;
  birthYearBsonType: string;
};

export class RegistrationProfileKpiAnalyticsService {
  static async getRegistrationProfileKpis(
    now = new Date(),
  ): Promise<RegistrationProfileKpisDTO> {
    const rows = await User.aggregate<RegistrationProfileKpiRow>([
      { $match: { isActive: true } },
      {
        $project: {
          _id: 0,
          isActive: 1,
          phone: 1,
          birthYear: 1,
          birthYearBsonType: { $type: "$birthYear" },
          residenceCity: 1,
          residenceRegion: 1,
          residenceCountryCode: 1,
          employmentStatus: 1,
          company: 1,
          occupation: 1,
        },
      },
    ]);

    return buildRegistrationProfileKpis(
      rows as RegistrationProfileKpiSource[],
      now,
    );
  }
}

export default RegistrationProfileKpiAnalyticsService;
