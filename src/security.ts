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
    EnforcementLevel, Policies, ReportViolation, ResourceValidationPolicy,
    StackValidation, StackValidationArgs, StackValidationPolicy,
    validateTypedResource,
} from "@pulumi/policy";

import { getValueOrDefault } from "./util";

import { Resource } from "@pulumi/pulumi";
import * as q from "@pulumi/pulumi/queryable";

// Milliseconds in a day.
const msInDay = 24 * 60 * 60 * 1000;

// SecurityPolicySettings defines the configuration parameters for any individual Compute policies
// that can be configured individually. If not provided, will default to a reasonable value
// from the AWS Guard module.
export interface SecurityPolicySettings {
    // For acmCheckCertificateExpiration policy:
    // Is the maximum number of days before an ACM certificate is set to expire before the
    // policy rule will report a violation.
    acmCheckCertificateExpirationMaxDays?: number;

    // For iamAccessKeysRotated policy:
    // The maximum age an IAM access key can be before it must be rotated.
    iamAccessKeysRotatedMaxDays?: number;
}

// getPolicies returns all Compute policies.
export function getPolicies(
    enforcement: EnforcementLevel, settings: SecurityPolicySettings): Policies {
    return [
        acmCheckCertificateExpiration(enforcement, getValueOrDefault(settings.acmCheckCertificateExpirationMaxDays, 14)),
        cmkBackingKeyRotationEnabled(enforcement),
        iamAccessKeysRotated(enforcement, getValueOrDefault(settings.iamAccessKeysRotatedMaxDays, 90)),
        iamMfaEnabledForConsoleAccess(enforcement),
    ];
}

export function acmCheckCertificateExpiration(enforcementLevel: EnforcementLevel = "advisory", maxDaysUntilExpiration: number): StackValidationPolicy {
    return {
        name: "acm-certificate-expiration",
        description: "Checks whether an ACM certificate has expired. Certificates provided by ACM are automatically renewed. ACM does not automatically renew certificates that you import.",
        enforcementLevel: enforcementLevel,
        validateStack: validateTypedResources(aws.acm.Certificate.isInstance, async (acmCertificates, args, reportViolation) => {
            const acm = new AWS.ACM();
            // Fetch the full ACM certificate using the AWS SDK to get its expiration date.
            for (const certInStack of acmCertificates) {
                const describeCertResp = await acm.describeCertificate({ CertificateArn: certInStack.id }).promise();

                const certDescription = describeCertResp.Certificate;
                if (certDescription && certDescription.NotAfter) {
                    let daysUntilExpiry = (certDescription.NotAfter.getTime() - Date.now()) / msInDay;
                    daysUntilExpiry = Math.floor(daysUntilExpiry);

                    if (daysUntilExpiry < maxDaysUntilExpiration) {
                        reportViolation(`certificate expires in ${daysUntilExpiry} (max allowed ${maxDaysUntilExpiration} days)`);
                    }
                }
            }
        }),
    };
}

export function cmkBackingKeyRotationEnabled(enforcementLevel: EnforcementLevel = "advisory"): ResourceValidationPolicy {
    return {
        name: "cmk-backing-key-rotation-enabled",
        description: "Checks that key rotation is enabled for each customer master key (CMK). Checks that key rotation is enabled for specific key object. Does not apply to CMKs that have imported key material.",
        enforcementLevel: enforcementLevel,
        validateResource: validateTypedResource(aws.kms.Key, async (instance, args, reportViolation) => {
            if (!instance.enableKeyRotation) {
                reportViolation("CMK does not have the key rotation setting enabled");
            }
        }),
    };
}

export function iamAccessKeysRotated(enforcementLevel: EnforcementLevel = "advisory", maxKeyAge: number): StackValidationPolicy {
    if (maxKeyAge < 1 || maxKeyAge > 2 * 365) {
        throw new Error("Invalid maxKeyAge.");
    }

    return {
        name: "access-keys-rotated",
        description: "Checks whether an access key have been rotated within maxKeyAge days.",
        enforcementLevel: enforcementLevel,
        validateStack: validateTypedResources(aws.iam.AccessKey.isInstance, async (accessKeys, args, reportViolation) => {
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
                            if (daysSinceCreated > maxKeyAge) {
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

export function iamMfaEnabledForConsoleAccess(enforcementLevel: EnforcementLevel = "advisory"): ResourceValidationPolicy {
    return {
        name: "mfa-enabled-for-iam-console-access",
        description: "Checks whether multi-factor Authentication (MFA) is enabled for an IAM user that use a console password.",
        enforcementLevel: enforcementLevel,
        validateResource: validateTypedResource(aws.iam.UserLoginProfile, async (instance, args, reportViolation) => {
            const iam = new AWS.IAM();
            const mfaDevicesResp = await iam.listMFADevices({ UserName: instance.user }).promise();
            // We don't bother with paging through all MFA devices, since we only check that there is at least one.
            if (mfaDevicesResp.MFADevices.length === 0) {
                reportViolation(`no MFA device enabled for IAM User '${instance.user}'`);
            }
        }),
    };
}

// Utility method for defining a new StackValidation that will return the resources matching the provided type.
function validateTypedResources<TResource extends Resource>(
    typeFilter: (o: any) => o is TResource,
    validate: (
        resources: q.ResolvedResource<TResource>[],
        args: StackValidationArgs,
        reportViolation: ReportViolation) => Promise<void> | void,
): StackValidation {
    return (args: StackValidationArgs, reportViolation: ReportViolation) => {
        const resources = args.resources
            .map(r => (<unknown>{ ...r.props, __pulumiType: r.type } as q.ResolvedResource<TResource>))
            .filter(typeFilter);
        validate(resources, args, reportViolation);
    };
}
