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
  DescribeServicesCommand
} from "@aws-sdk/client-ecs"

import { createWaiter, WaiterState, checkExceptions } from "@aws-sdk/util-waiter"

import fs from "fs"
import path from "path"
const core = require("@actions/core")

const region = process.env.AWS_REGION
const client = new ECSClient({ region })

const FAILED_TASKS = 'Failed to start some ECS tasks'

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

/**
 * @param {Object} ecsService - the object representing the ECS service returned by `aws ecs describe-services ...`
 */
const logDeploymentState = (ecsService) => {
  const inProgressDeployment = currentDeployment(ecsService)
  const progress = inProgressDeployment.desiredCount === 0 ? 0 : (inProgressDeployment.runningCount / inProgressDeployment.desiredCount) * 100
  const status = `${inProgressDeployment.status} | ${inProgressDeployment.rolloutState} ${progress}%`
  const tasks = `${inProgressDeployment.runningCount} Running | ${inProgressDeployment.pendingCount} Pending | ${inProgressDeployment.desiredCount} Desired | ${inProgressDeployment.failedTasks} Failed`

  core.info(`Status: [${status}], Tasks: [${tasks}]`)
}

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

    logDeploymentState(ecsService)

    try {
      if (successfullyDeployed(ecsService)) {
        core.info(`Deployment successfull`)
        return { state: WaiterState.SUCCESS, reason };
      }

      if (deploymentHasFailedTasks(ecsService)) {
        logCurrentDeploymentState(ecsService)
        triggerRollbackAndFailBuild(ecsService)
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
    minDelay: 5, // 5 secs
    maxDelay: 5 // 5 secs
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
const updateEcsService = async (cluster, service, forceNewDeployment, newTaskDefinitionArn, desiredCount) => {
  core.info(`Starting ECS deployment (task definition: ${newTaskDefinitionArn})...`)

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
  const desiredCount = core.getInput('desiredCount', { required: alse }) || null

  try {
    const newTaskDefinitionArn = await registerNewTaskDefinition(taskDefinitionFilePath)
    await updateEcsService(cluster, service, forceNewDeployment, newTaskDefinitionArn, desiredCount)
  } catch (error) {
    core.setFailed(error.message)
    core.error(error.stack)
  }
}

run()
