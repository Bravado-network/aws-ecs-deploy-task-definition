/**
 * This will register a new task definition, update the ECS service with the new task definition and poll the ECS service to check the deployment state.
 * It stops polling the ECS service if:
 * - The deployment succeed
 * - The deployment fails: in this case, it'll rollback the ECS service to the previous task definition
 */

import { 
  ECSClient,
  RegisterTaskDefinitionCommand,
  UpdateServiceCommand,
  DescribeServicesCommand,
  ListTasksCommand,
  DescribeTasksCommand
} from "@aws-sdk/client-ecs"

import { 
  CloudWatchLogsClient,
  GetLogEventsCommand
} from "@aws-sdk/client-cloudwatch-logs"

import { createWaiter, WaiterState, checkExceptions } from "@aws-sdk/util-waiter"

import fs from "fs"
import path from "path"
const core = require("@actions/core")
import { setTimeout } from 'timers/promises';

const region = process.env.AWS_REGION
const client = new ECSClient({ region })
const cloudWatchLogsClient = new CloudWatchLogsClient({ region })

const FAILED_TASKS = 'Failed to start some ECS tasks'

// Store the last seen event for each log stream
const lastSeenEvents = new Map();

/**
 * Registers a new task definition. The corresponding AWS CLI command is something similar to the example bellow:
 * 
 * @example
 * ```javascript
 * aws ecs register-task-definition --family backend-devops \
    --cli-input-json file://./backendTaskDefinition.json \
    --region us-east-2
 * ```
 * @param {String} taskDefinitionFilePath - the path to the task definition file
 * @returns {String} the new registered task definition to be deployed
 */

const registerNewTaskDefinition = async (taskDefinitionFilePath) => {
  const fileContent = fs.readFileSync(taskDefinitionFilePath, "utf8")
  const taskDefinition = JSON.parse(fileContent)
  
  core.info(`Registering the task definition based on ${taskDefinition.taskDefinitionArn}`)

  try {
    const taskDefinitionCommandResult = await client.send(new RegisterTaskDefinitionCommand(taskDefinition))
    const { family, revision } = taskDefinitionCommandResult.taskDefinition
    core.info(`New Task definition (revision: ${revision}) URL: https://${region}.console.aws.amazon.com/ecs/v2/task-definitions/${family}/${revision}/containers`)
    
    return taskDefinitionCommandResult.taskDefinition.taskDefinitionArn
  } catch (error) {
    core.setFailed("Failed to register task definition in ECS: " + error.message)
    core.info("Task definition contents:")
    core.info(fileContent)
    throw(error)
  }
}

// Add new function to fetch CloudWatch logs
const fetchCloudWatchLogs = async (logGroupName, logStreamName) => {
  try {
    const lastSeenToken = lastSeenEvents.get(`${logGroupName}:${logStreamName}`);
    
    const params = {
      logGroupName,
      logStreamName,
      startFromHead: true,
      ...(lastSeenToken && { nextToken: lastSeenToken })
    };
    
    const response = await cloudWatchLogsClient.send(new GetLogEventsCommand(params));
    
    // Store the next token for subsequent requests
    if (response.nextForwardToken) {
      lastSeenEvents.set(`${logGroupName}:${logStreamName}`, response.nextForwardToken);
    }
    
    // Only return logs if we have events
    if (response.events && response.events.length > 0) {
      return response.events.map(event => event.message).join('\n');
    }
    return null;
  } catch (error) {
    core.warning(`Failed to fetch CloudWatch logs: ${error.message}`);
    return null;
  }
}

const fetchTaskLogs = async (ecsService) => {
  // Add 40-second delay before first log fetch
  const isFirstRun = !lastSeenEvents.size;
  if (isFirstRun) {
    core.info('Waiting 40 seconds before container spin up...');
    await setTimeout(40000); // 40 seconds
  }

  core.info(`Fetching logs for service: ${ecsService.serviceName}`);
  
  // Get the current deployment's task definition
  const currentDeployment = ecsService.deployments.find(d => d.status === 'PRIMARY');
  if (!currentDeployment) {
    core.info('No primary deployment found');
    return;
  }
  const currentTaskDefinition = currentDeployment.taskDefinition;
  
  // Get list of tasks
  const listTasksResponse = await client.send(new ListTasksCommand({
    cluster: ecsService.clusterArn,
    serviceName: ecsService.serviceName
  }));
  
  if (!listTasksResponse.taskArns || listTasksResponse.taskArns.length === 0) {
    core.info('No tasks found for the service');
    return;
  }
  
  // Get detailed task information
  const describeTasksResponse = await client.send(new DescribeTasksCommand({
    cluster: ecsService.clusterArn,
    tasks: listTasksResponse.taskArns
  }));
  
  // Filter for tasks using the current deployment's task definition
  const tasks = (describeTasksResponse.tasks || [])
    .filter(task => task.taskDefinitionArn === currentTaskDefinition);
  
  for (const task of tasks) {
    const logGroupName = `${ecsService.serviceName}-logs`;
    const logStreamName = `${ecsService.serviceName}/${ecsService.serviceName}/${task.taskArn.split('/').pop()}`;
    
    const logs = await fetchCloudWatchLogs(logGroupName, logStreamName);
    if (logs) {
      core.info(`New logs for task ${task.taskArn}:`);
      core.info(logs);
    }
  }
}


/**
 * @param {Object} ecsService - the object representing the ECS service returned by `aws ecs describe-services ...`
 */


/**
 * @param {Object} ecsService - the object representing the ECS service returned by `aws ecs describe-services ...`
 */
const logCurrentDeploymentState = (ecsService) => {
  ecsService.deployments.forEach(deployment => {
    const status = `${deployment.status} | ${deployment.rolloutState} (${deployment.rolloutStateReason}) ${(deployment.runningCount / deployment.desiredCount) * 100}%`
    const tasks = `${deployment.runningCount} Running | ${deployment.pendingCount} Pending | ${deployment.desiredCount} Desired | ${deployment.failedTasks} Failed`

    core.error(`ID: [${deployment.id}], Status: [${status}], Tasks: [${tasks}], Task Definition: [${deployment.taskDefinition}]`)
  })
}

/**
 * Determintes if the deployment has succeeded
 * 
 * @param {Object} ecsService - the object representing the ECS service returned by `aws ecs describe-services ...`
 * @returns 
 */
const successfullyDeployed = (ecsService) => {
  return ecsService.deployments.length === 1 && ecsService.runningCount === ecsService.desiredCount
}

/**
 * The current deployment has status = PRIMARY. The previous deployment which is about to be replaced has status = 'ACTIVE'
 * 
 * @param {Object} ecsService - the object representing the ECS service returned by `aws ecs describe-services ...`
 * @returns 
 */
const currentDeployment = (ecsService) => ecsService.deployments.find(deployment => deployment.status === 'PRIMARY')

/**
 * Determines if the current in progress deployment has failed to start some task.
 * 
 * @param {Object} ecsService - the object representing the ECS service returned by `aws ecs describe-services ...`
 * @returns 
 */
const deploymentHasFailedTasks = (ecsService) => {
  const inProgressDeployment = currentDeployment(ecsService)
  return inProgressDeployment.failedTasks > 0
}

const triggerRollbackAndFailBuild = async (ecsService) => {
  const previousDeployment = ecsService.deployments.find(deployment => deployment.status === 'ACTIVE')
  
  // Fetch logs before rolling back
  const currentDeploymentTasks = ecsService.tasks || []
  for (const task of currentDeploymentTasks) {
    if (task.lastStatus === 'STOPPED') {
      const logGroupName = `${ecsService.serviceName}`
      const logStreamName = `${ecsService.serviceName}/${ecsService.serviceName}/${task.taskArn.split('/').pop()}`
      
      const logs = await fetchCloudWatchLogs(logGroupName, logStreamName)
      if (logs) {
        core.error(`Logs for failed task ${task.taskArn}:`)
        core.error(logs)
      }
    }
  }
        
  await client.send(new UpdateServiceCommand({ 
    cluster: ecsService.clusterArn,
    service: ecsService.serviceName,      
    taskDefinition: previousDeployment.taskDefinition
  }))

  core.setFailed(`Rolling back deployment to previous version`)  
}

/**
 * Checks the deploymnet state and determines if the polling should stop or not.
 * The corresponding AWS CLI command is something similar to the example bellow:
 * 
 * @example
 * ```javascript
 * aws ecs describe-services --cluster ecs-cluster-dev \
    --services frontend-dev \
    --region us-east-1
 * ```
 * @param {ECSClient} ecsClient 
 * @param {Object} describeServicesInput - the params to `aws ecs describe-services ...`
 * @returns {Object} returns to the polling mechanism if it should continue or stop
 */
const checkDeploymentState = async (ecsClient, describeServicesInput) => {
  let reason;
  const service = core.getInput('service', { required: true })
  try {
    const result = await ecsClient.send(new DescribeServicesCommand(describeServicesInput));
    const ecsService = result.services.find((ecsService) => ecsService.serviceName === service)
    reason = result;
    await fetchTaskLogs(ecsService)

    try {
      if (successfullyDeployed(ecsService)) {
        core.info(`Deployment successful`)
        return { state: WaiterState.SUCCESS, reason };
      }

      if (deploymentHasFailedTasks(ecsService)) {
        logCurrentDeploymentState(ecsService)
        await triggerRollbackAndFailBuild(ecsService)
        return { state: WaiterState.ABORTED, reason: FAILED_TASKS }
      }
    } catch (e) {}
  } catch (exception) {
    reason = exception;
    core.error(exception)
  }

  return { state: WaiterState.RETRY, reason };
}

/**
 * Polls the ECS service to check the deployment state. The function `checkDeploymentState` will be called in the interval specified by `pollingConfig`.
 * 
 * @param {String} cluster - the ECS cluster name
 * @param {String} service - the ECS service name
 * @returns 
 */
const startECSPollingToCheckDeploymentState = async (cluster, service) => {
  const pollingConfig = { 
    client: client,
    maxWaitTime: 900, // 15 min
    minDelay: 10, // 10 secs
    maxDelay: 15 // 15 secs
  }

  const ecsDescribeServiceParams = {
    cluster,
    services: [service]
  }

  return await createWaiter(pollingConfig, ecsDescribeServiceParams, checkDeploymentState)
}

/**
 * Updates the ECS service specified in the param with the new task definition. 
 * The corresponding AWS CLI command is something similar to the example bellow:
 * 
 * @example
 * ```javascript
 * aws ecs update-service --cluster ecs-cluster-fargate-poc \
    --service backend-fargate-poc \
    --cli-input-json file://fargate-backend-service.json \
    --region us-west-2
 * ```
 * @param {String} cluster - the ECS cluster name
 * @param {String} service - the ECS service name
 * @param {Boolean} forceNewDeployment - specify to force a new deployment or not
 * @param {Object} newTaskDefinitionArn - the new task definition to be deployed
 * @returns 
 */
const updateEcsService = async (cluster, service, forceNewDeployment, newTaskDefinitionArn) => {
  core.info(`Starting ECS deployment (task definition: ${newTaskDefinitionArn})...`)

  const desiredCount = cluster.includes('dev') ? 1 : undefined;
  const commandParams = {
    cluster,
    service,
    forceNewDeployment,
    taskDefinition: newTaskDefinitionArn,
    ...(desiredCount !== undefined && { desiredCount })  // Add desiredCount only if defined
  };

  await client.send(new UpdateServiceCommand(commandParams));

  const result = await startECSPollingToCheckDeploymentState(cluster, service)
  
  return checkExceptions(result)
}

/**
 * Registers a new task definition and then update the ECS service with it
 */
const run = async () => {
  const taskDefinitionFile = core.getInput("task-definition", { required: true })
  const taskDefinitionFilePath = path.isAbsolute(taskDefinitionFile) ?
      taskDefinitionFile :
      path.join(process.env.GITHUB_WORKSPACE, taskDefinitionFile)

  const cluster = core.getInput('cluster', { required: true })
  const service = core.getInput('service', { required: true })
  const forceNewDeployInput = core.getInput('force-new-deployment', { required: false }) || 'false'
  const forceNewDeployment = forceNewDeployInput.toLowerCase() === 'true'

  try {
    const newTaskDefinitionArn = await registerNewTaskDefinition(taskDefinitionFilePath)
    await updateEcsService(cluster, service, forceNewDeployment, newTaskDefinitionArn)
  } catch (error) {
    core.setFailed(error.message)
    core.error(error.stack)
  }
}

run()
