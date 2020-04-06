// Copyright 2016-2019, Pulumi Corporation.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as AWS from "aws-sdk";

import * as aws from "@pulumi/aws";

import {
    EnforcementLevel,
    ResourceValidationPolicy,
    StackValidationPolicy,
    validateResourceOfType,
    validateStackResourcesOfType,
} from "@pulumi/policy";

import { registerPolicyOld } from "./awsGuard";
import { defaultEnforcementLevel } from "./enforcementLevel";
import { PolicyArgs } from "./policyArgs";
import { getValueOrDefault } from "./util";

// Mixin additional properties onto AwsGuardArgs.
declare module "./awsGuard" {
    interface AwsGuardArgs {
        acmCertificateExpiration?: EnforcementLevel | AcmCertificateExpirationArgs;
        cmkBackingKeyRotationEnabled?: EnforcementLevel;
        iamAccessKeysRotated?: EnforcementLevel | IamAccessKeysRotatedArgs;
        iamMfaEnabledForConsoleAccess?: EnforcementLevel;
    }
}

// Register policy factories.
registerPolicyOld("acmCertificateExpiration", acmCertificateExpiration);
registerPolicyOld("cmkBackingKeyRotationEnabled", cmkBackingKeyRotationEnabled);
registerPolicyOld("iamAccessKeysRotated", iamAccessKeysRotated);
registerPolicyOld("iamMfaEnabledForConsoleAccess", iamMfaEnabledForConsoleAccess);

// Milliseconds in a day.
const msInDay = 24 * 60 * 60 * 1000;

export interface AcmCertificateExpirationArgs extends PolicyArgs {
    /** Max days before certificate expires. Defaults to 14. */
    maxDaysUntilExpiration?: number;
}

/** @internal */
export function acmCertificateExpiration(args?: EnforcementLevel | AcmCertificateExpirationArgs): StackValidationPolicy {
    const { enforcementLevel, maxDaysUntilExpiration } = getValueOrDefault(args, {
        enforcementLevel: defaultEnforcementLevel,
        maxDaysUntilExpiration: 14,
    });

    return {
        name: "acm-certificate-expiration",
        description: "Checks whether an ACM certificate has expired. Certificates provided by ACM are automatically renewed. ACM does not automatically renew certificates that you import.",
        enforcementLevel: enforcementLevel,
        validateStack: validateStackResourcesOfType(aws.acm.Certificate, async (acmCertificates, _, reportViolation) => {
            const acm = new AWS.ACM();
            // Fetch the full ACM certificate using the AWS SDK to get its expiration date.
            for (const certInStack of acmCertificates) {
                const describeCertResp = await acm.describeCertificate({ CertificateArn: certInStack.id }).promise();

                const certDescription = describeCertResp.Certificate;
                if (certDescription && certDescription.NotAfter) {
                    let daysUntilExpiry = (certDescription.NotAfter.getTime() - Date.now()) / msInDay;
                    daysUntilExpiry = Math.floor(daysUntilExpiry);

                    if (daysUntilExpiry < maxDaysUntilExpiration!) {
                        reportViolation(`certificate expires in ${daysUntilExpiry} (max allowed ${maxDaysUntilExpiration} days)`);
                    }
                }
            }
        }),
    };
}

/** @internal */
export function cmkBackingKeyRotationEnabled(enforcementLevel?: EnforcementLevel): ResourceValidationPolicy {
    return {
        name: "cmk-backing-key-rotation-enabled",
        description: "Checks that key rotation is enabled for each customer master key (CMK). Checks that key rotation is enabled for specific key object. Does not apply to CMKs that have imported key material.",
        enforcementLevel: enforcementLevel || defaultEnforcementLevel,
        validateResource: validateResourceOfType(aws.kms.Key, async (instance, _, reportViolation) => {
            if (!instance.enableKeyRotation) {
                reportViolation("CMK does not have the key rotation setting enabled");
            }
        }),
    };
}

export interface IamAccessKeysRotatedArgs extends PolicyArgs {
    /** Max key age in days. Defaults to 90. */
    maxKeyAge?: number;
}

/** @internal */
export function iamAccessKeysRotated(args?: EnforcementLevel | IamAccessKeysRotatedArgs): StackValidationPolicy {
    const { enforcementLevel, maxKeyAge } = getValueOrDefault(args, {
        enforcementLevel: defaultEnforcementLevel,
        maxKeyAge: 90,
    });

    if (maxKeyAge! < 1 || maxKeyAge! > 2 * 365) {
        throw new Error("Invalid maxKeyAge.");
    }

    return {
        name: "access-keys-rotated",
        description: "Checks whether an access key have been rotated within maxKeyAge days.",
        enforcementLevel: enforcementLevel,
        validateStack: validateStackResourcesOfType(aws.iam.AccessKey, async (accessKeys, _, reportViolation) => {
            const iam = new AWS.IAM();
            for (const instance of accessKeys) {
                // Skip any access keys that haven't yet been provisioned or whose status is inactive.
                if (!instance.id || instance.status !== "Active") {
                    continue;
                }

                // Use the AWS SDK to list the access keys for the user, which will contain the key's creation date.
                let paginationToken = undefined;

                let accessKeysResp: AWS.IAM.ListAccessKeysResponse;
                do {
                    accessKeysResp = await iam.listAccessKeys({ UserName: instance.user, Marker: paginationToken }).promise();
                    for (const accessKey of accessKeysResp.AccessKeyMetadata) {
                        if (accessKey.AccessKeyId === instance.id && accessKey.CreateDate) {
                            let daysSinceCreated = (Date.now() - accessKey.CreateDate!.getTime()) / msInDay;
                            daysSinceCreated = Math.floor(daysSinceCreated);
                            if (daysSinceCreated > maxKeyAge!) {
                                reportViolation(`access key must be rotated within ${maxKeyAge} days (key is ${daysSinceCreated} days old)`);
                            }
                        }
                    }

                    paginationToken = accessKeysResp.Marker;
                } while (accessKeysResp.IsTruncated);
            }
        }),
    };
}

/** @internal */
export function iamMfaEnabledForConsoleAccess(enforcementLevel?: EnforcementLevel): ResourceValidationPolicy {
    return {
        name: "mfa-enabled-for-iam-console-access",
        description: "Checks whether multi-factor Authentication (MFA) is enabled for an IAM user that use a console password.",
        enforcementLevel: enforcementLevel || defaultEnforcementLevel,
        validateResource: validateResourceOfType(aws.iam.UserLoginProfile, async (instance, _, reportViolation) => {
            const iam = new AWS.IAM();
            const mfaDevicesResp = await iam.listMFADevices({ UserName: instance.user }).promise();
            // We don't bother with paging through all MFA devices, since we only check that there is at least one.
            if (mfaDevicesResp.MFADevices.length === 0) {
                reportViolation(`no MFA device enabled for IAM User '${instance.user}'`);
            }
        }),
    };
}
