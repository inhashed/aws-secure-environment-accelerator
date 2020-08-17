import * as AWS from 'aws-sdk';
import {
  CloudFormationCustomResourceEvent,
  CloudFormationCustomResourceCreateEvent,
  CloudFormationCustomResourceUpdateEvent,
  CloudFormationCustomResourceDeleteEvent,
} from 'aws-lambda';
import { errorHandler } from '@aws-accelerator/custom-resource-runtime-cfn-response';

const ec2 = new AWS.EC2();
const secretsManager = new AWS.SecretsManager();

export interface HandlerProperties {
  keyName: string;
  secretPrefix: string;
}

export const handler = errorHandler(onEvent);

async function onEvent(event: CloudFormationCustomResourceEvent) {
  console.log(`Generating keypair...`);
  console.log(JSON.stringify(event, null, 2));

  // tslint:disable-next-line: switch-default
  switch (event.RequestType) {
    case 'Create':
      return onCreate(event);
    case 'Update':
      return onUpdate(event);
    case 'Delete':
      return onDelete(event);
  }
}

function getPhysicalId(event: CloudFormationCustomResourceEvent): string {
  const properties = (event.ResourceProperties as unknown) as HandlerProperties;

  return `${properties.secretPrefix}${properties.keyName}`;
}

async function onCreate(event: CloudFormationCustomResourceCreateEvent) {
  const properties = (event.ResourceProperties as unknown) as HandlerProperties;
  const response = await generateKeypair(properties);
  return {
    physicalResourceId: getPhysicalId(event),
    data: {
      KeyName: response.KeyName,
    },
  };
}

async function onUpdate(event: CloudFormationCustomResourceUpdateEvent) {
  // delete old keypair
  // TODO Do not delete the old keypair if the name did not change
  //      This could happen when the `secretPrefix` changes
  const oldProperties = (event.OldResourceProperties as unknown) as HandlerProperties;
  await deleteKeypair(oldProperties);

  // create new keypair
  const newProperties = (event.ResourceProperties as unknown) as HandlerProperties;
  const response = await generateKeypair(newProperties);
  return {
    physicalResourceId: getPhysicalId(event),
    data: {
      KeyName: response.KeyName,
    },
  };
}

async function onDelete(event: CloudFormationCustomResourceDeleteEvent) {
  const properties = (event.ResourceProperties as unknown) as HandlerProperties;
  await deleteKeypair(properties);
  return {
    physicalResourceId: getPhysicalId(event),
  };
}

async function generateKeypair(properties: HandlerProperties) {
  const createKeyPair = await ec2
    .createKeyPair({
      KeyName: properties.keyName,
    })
    .promise();

  const secretName = `${properties.secretPrefix}${properties.keyName}`;
  try {
    await secretsManager
      .createSecret({
        Name: secretName,
        SecretString: createKeyPair.KeyMaterial,
      })
      .promise();
  } catch (e) {
    const message = `${e}`;
    if (!message.includes(`already scheduled for deletion`)) {
      throw e;
    }

    // Restore the deleted secret and put the key material in
    await secretsManager
      .restoreSecret({
        SecretId: secretName,
      })
      .promise();
    await secretsManager
      .putSecretValue({
        SecretId: secretName,
        SecretString: createKeyPair.KeyMaterial,
      })
      .promise();
  }
  return createKeyPair;
}

async function deleteKeypair(properties: HandlerProperties) {
  await ec2
    .deleteKeyPair({
      KeyName: properties.keyName,
    })
    .promise();

  const secretName = `${properties.secretPrefix}${properties.keyName}`;
  await secretsManager
    .deleteSecret({
      SecretId: secretName,
    })
    .promise();
}