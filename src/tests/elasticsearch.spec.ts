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

import "mocha";

import * as aws from "@pulumi/aws";

import * as elasticsearch from "../elasticsearch";
import { assertHasResourceViolation, assertNoResourceViolations, createResourceValidationArgs } from "./util";

describe("#elasticsearchEncryptedAtRest", () => {
    const policy = elasticsearch.elasticsearchEncryptedAtRest;
    const domainName = "test-name";

    it("Should fail if domain's encryptAtRest is undefined", async () => {
        const args = createResourceValidationArgs(aws.elasticsearch.Domain, {
            domainName: domainName,
        });

        const msg = `Elasticsearch domain ${domainName} must be encrypted at rest.`;
        await assertHasResourceViolation(policy, args, { message: msg });
    });
    it("Should fail if domain's encryptAtRest is disabled", async () => {
        const args = createResourceValidationArgs(aws.elasticsearch.Domain, {
            domainName: domainName,
            encryptAtRest: {
                enabled: false,
            },
        });

        const msg = `Elasticsearch domain ${domainName} must be encrypted at rest.`;
        await assertHasResourceViolation(policy, args, { message: msg });
    });

    it("Should pass if encryptAtRest is enabled", async () => {
        const args = createResourceValidationArgs(aws.elasticsearch.Domain, {
            domainName: domainName,
            encryptAtRest: {
                enabled: true,
            },
        });

        await assertNoResourceViolations(policy, args);
    });
});

describe("#elasticsearchInVpcOnly", () => {
    const policy = elasticsearch.elasticsearchInVpcOnly;

    it("Should fail if no VPC options are available", async () => {
        const args = createResourceValidationArgs(aws.elasticsearch.Domain, {});

        await assertHasResourceViolation(policy, args, { message: "must run within a VPC." });
    });

    it("Should pass if VPC options are available", async () => {
        const args = createResourceValidationArgs(aws.elasticsearch.Domain, {
            vpcOptions: {},
        });

        await assertNoResourceViolations(policy, args);
    });
});
