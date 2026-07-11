// https://docs.x.com/x-api/activity/introduction
import type { UserMetadata } from "./dataTypes";

export const UserMetadata_X: UserMetadata[] = [
  {
    sourceUserType: "get-followers", // https://docs.x.com/x-api/users/get-followers
    linkPrefix: "data[]",
    userProps: [
      { propId: "source_user_id", dataId: "{linkPrefix}.id" },
      { propId: "name", dataId: "{linkPrefix}.name" },
      { propId: "username", dataId: "{linkPrefix}.username" },
      { propId: "is_followed", value: 1 },
    ],
  },
];
